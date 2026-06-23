package main

import (
	"crypto/sha256"
	"embed"
	"encoding/hex"
	"flag"
	"fmt"
	"image"
	"io"
	"io/fs"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"

	"github.com/disintegration/imaging"
	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"
	minio "github.com/minio/minio-go/v7"
	"github.com/minio/minio-go/v7/pkg/credentials"
)

//go:embed all:static
var frontendFS embed.FS

const (
	defaultAddress    = ":8080"
	defaultCacheDir   = "./previews"
	defaultPreviewW   = 320
	maxPreviewWidth   = 1200
	jpegQuality       = 82
)

var cacheDir string

func main() {
	flag.Parse()

	cacheDir = os.Getenv("PREVIEW_CACHE_DIR")
	if cacheDir == "" {
		cacheDir = defaultCacheDir
	}
	if err := os.MkdirAll(cacheDir, 0755); err != nil {
		log.Fatalf("failed to create cache dir: %v", err)
	}

	// Also ensure the embedded static dir exists in source (for dev)
	_ = os.MkdirAll("static", 0755)

	r := chi.NewRouter()
	r.Use(middleware.RequestID)
	r.Use(middleware.RealIP)
	r.Use(middleware.Logger)
	r.Use(middleware.Recoverer)

	// API routes (with CORS for the custom X-Minio headers)
	r.Group(func(r chi.Router) {
		r.Use(corsMiddleware)
		r.Get("/health", func(w http.ResponseWriter, r *http.Request) {
			w.WriteHeader(http.StatusOK)
			w.Write([]byte("ok"))
		})
		r.Get("/preview", previewHandler)
	})

	// Serve the embedded React frontend (SPA)
	// Build step: cd frontend && npm run build   (it copies into backend/static)
	distFS, err := fs.Sub(frontendFS, "static")
	if err != nil {
		log.Fatalf("failed to load embedded frontend (run `npm run build` in the frontend/ directory first): %v", err)
	}
	spa := spaFileServer(distFS)
	r.Get("/*", spa)
	r.Head("/*", spa)

	addr := resolveListenAddress()

	log.Printf("Family Storage listening on %s (preview cache: %s)", addr, cacheDir)
	if err := http.ListenAndServe(addr, r); err != nil {
		log.Fatal(err)
	}
}

var listenAddress string

func init() {
	flag.StringVar(&listenAddress, "address", "", "Address to listen on (e.g. :8080, 0.0.0.0:8080, 127.0.0.1:9000)")
	flag.StringVar(&listenAddress, "a", "", "Shorthand for --address")
}

func resolveListenAddress() string {
	// 1. Command line flag (highest priority)
	if listenAddress != "" {
		return normalizeAddress(listenAddress)
	}

	// 2. ADDRESS environment variable
	if addr := os.Getenv("ADDRESS"); addr != "" {
		return normalizeAddress(addr)
	}

	// 3. PORT environment variable (legacy support)
	if port := os.Getenv("PORT"); port != "" {
		return normalizeAddress(":" + port)
	}

	return defaultAddress
}

func normalizeAddress(addr string) string {
	addr = strings.TrimSpace(addr)
	if addr == "" {
		return defaultAddress
	}
	// If user passed just a port number (e.g. "9000"), treat it as ":9000"
	if !strings.Contains(addr, ":") {
		return ":" + addr
	}
	return addr
}

func corsMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Access-Control-Allow-Methods", "GET, OPTIONS")
		w.Header().Set("Access-Control-Allow-Headers", "Content-Type, X-Minio-Endpoint, X-Minio-Access-Key, X-Minio-Secret-Key, X-Minio-Use-SSL")
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		next.ServeHTTP(w, r)
	})
}

// previewHandler generates and serves image previews
func previewHandler(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()

	bucket := r.URL.Query().Get("bucket")
	object := r.URL.Query().Get("object")
	if bucket == "" || object == "" {
		http.Error(w, "missing bucket or object", http.StatusBadRequest)
		return
	}

	width := defaultPreviewW
	if wStr := r.URL.Query().Get("w"); wStr != "" {
		if parsed, err := strconv.Atoi(wStr); err == nil && parsed > 0 {
			width = parsed
		}
	}
	if width > maxPreviewWidth {
		width = maxPreviewWidth
	}

	endpoint := getHeader(r, "X-Minio-Endpoint", "127.0.0.1:7000")
	accessKey := getHeader(r, "X-Minio-Access-Key", "")
	secretKey := getHeader(r, "X-Minio-Secret-Key", "")
	useSSL := strings.ToLower(getHeader(r, "X-Minio-Use-SSL", "false")) == "true"

	if accessKey == "" || secretKey == "" {
		http.Error(w, "missing minio credentials", http.StatusUnauthorized)
		return
	}

	client, err := newMinioClient(endpoint, accessKey, secretKey, useSSL)
	if err != nil {
		http.Error(w, "failed to connect to minio: "+err.Error(), http.StatusBadGateway)
		return
	}

	// Get object info for better caching (ETag)
	objInfo, err := client.StatObject(ctx, bucket, object, minio.StatObjectOptions{})
	if err != nil {
		http.Error(w, "object not found: "+err.Error(), http.StatusNotFound)
		return
	}

	cacheKey := makeCacheKey(endpoint, bucket, object, objInfo.ETag, width)
	previewPath := filepath.Join(cacheDir, cacheKey+".jpg")

	// Serve from cache if exists
	if fi, err := os.Stat(previewPath); err == nil && fi.Size() > 0 {
		w.Header().Set("Content-Type", "image/jpeg")
		w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
		w.Header().Set("ETag", fmt.Sprintf(`"%s"`, cacheKey))
		http.ServeFile(w, r, previewPath)
		return
	}

	// Fetch original
	obj, err := client.GetObject(ctx, bucket, object, minio.GetObjectOptions{})
	if err != nil {
		http.Error(w, "failed to get object: "+err.Error(), http.StatusBadGateway)
		return
	}
	defer obj.Close()

	// Decode image
	src, _, err := image.Decode(obj)
	if err != nil {
		// Try to decode as-is with imaging (more tolerant)
		_, _ = obj.Seek(0, io.SeekStart)
		src, err = imaging.Decode(obj)
	}
	if err != nil {
		http.Error(w, "unsupported image format or decode error", http.StatusUnsupportedMediaType)
		return
	}

	// Resize (fit within width, keep aspect)
	dst := imaging.Fit(src, width, width*2, imaging.Lanczos) // generous height

	// Write to temp file then atomic rename
	tmpPath := previewPath + ".tmp"
	out, err := os.Create(tmpPath)
	if err != nil {
		http.Error(w, "cache write error", http.StatusInternalServerError)
		return
	}

	err = imaging.Encode(out, dst, imaging.JPEG, imaging.JPEGQuality(jpegQuality))
	closeErr := out.Close()

	if err != nil || closeErr != nil {
		_ = os.Remove(tmpPath)
		http.Error(w, "encode error", http.StatusInternalServerError)
		return
	}

	if err := os.Rename(tmpPath, previewPath); err != nil {
		_ = os.Remove(tmpPath)
		http.Error(w, "cache save error", http.StatusInternalServerError)
		return
	}

	// Serve freshly generated
	w.Header().Set("Content-Type", "image/jpeg")
	w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
	w.Header().Set("ETag", fmt.Sprintf(`"%s"`, cacheKey))
	http.ServeFile(w, r, previewPath)
}

func newMinioClient(endpoint, accessKey, secretKey string, useSSL bool) (*minio.Client, error) {
	// endpoint can be "127.0.0.1:7000" or "localhost:9000"
	client, err := minio.New(endpoint, &minio.Options{
		Creds:  credentials.NewStaticV4(accessKey, secretKey, ""),
		Secure: useSSL,
	})
	if err != nil {
		return nil, err
	}
	return client, nil
}

func getHeader(r *http.Request, key, fallback string) string {
	if v := r.Header.Get(key); v != "" {
		return v
	}
	return fallback
}

func makeCacheKey(endpoint, bucket, object, etag string, width int) string {
	h := sha256.New()
	h.Write([]byte(endpoint + "|" + bucket + "|" + object + "|" + etag + "|" + strconv.Itoa(width)))
	return hex.EncodeToString(h.Sum(nil))[:32] // short but unique
}

// spaFileServer serves static files from the embedded frontend dist.
// For any path that doesn't match a real file (SPA routes), it falls back to index.html.
func spaFileServer(fsys fs.FS) http.HandlerFunc {
	fileServer := http.FileServer(http.FS(fsys))

	return func(w http.ResponseWriter, r *http.Request) {
		// Try to serve an exact file (js, css, images, favicon, etc.)
		// Remove leading slash for fs.Open
		requestPath := strings.TrimPrefix(r.URL.Path, "/")
		if requestPath == "" {
			requestPath = "index.html"
		}

		if f, err := fsys.Open(requestPath); err == nil {
			f.Close()
			fileServer.ServeHTTP(w, r)
			return
		}

		// No exact file → serve index.html so React Router can handle the path
		r.URL.Path = "/"
		fileServer.ServeHTTP(w, r)
	}
}



