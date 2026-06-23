package main

import (
	"crypto/sha256"
	"embed"
	"encoding/hex"
	"encoding/json"
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
	"time"

	"github.com/disintegration/imaging"
	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"
	minio "github.com/minio/minio-go/v7"
	"github.com/minio/minio-go/v7/pkg/credentials"
	madmin "github.com/minio/madmin-go/v3"
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
		r.Post("/admin/create-user", adminCreateUserHandler)
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
	effectiveMinio := resolveMinioAddress()
	if effectiveMinio == "" {
		effectiveMinio = "(per-request from client)"
	}

	ak, sk := resolveMinioCredentials()
	backendCreds := "no"
	if ak != "" && sk != "" {
		backendCreds = "yes"
	}

	log.Printf("Family Storage listening on %s (preview cache: %s, minio: %s, backend-creds: %s)", addr, cacheDir, effectiveMinio, backendCreds)
	if err := http.ListenAndServe(addr, r); err != nil {
		log.Fatal(err)
	}
}

var listenAddress string
var minioAddress string
var minioUser string
var minioPass string

func init() {
	flag.StringVar(&listenAddress, "address", "", "Address to listen on (e.g. :8080, 0.0.0.0:8080, 127.0.0.1:9000)")
	flag.StringVar(&listenAddress, "a", "", "Shorthand for --address")

	flag.StringVar(&minioAddress, "minio", "", "MinIO server address (host:port) for the backend to use when talking to MinIO")
	flag.StringVar(&minioAddress, "m", "", "Shorthand for --minio")

	flag.StringVar(&minioUser, "user", "", "MinIO access key for backend operations")
	flag.StringVar(&minioUser, "u", "", "Shorthand for --user")

	flag.StringVar(&minioPass, "pass", "", "MinIO secret key for backend operations")
	flag.StringVar(&minioPass, "p", "", "Shorthand for --pass")
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

func resolveMinioAddress() string {
	if minioAddress != "" {
		return normalizeMinioAddress(minioAddress)
	}
	if addr := os.Getenv("MINIO"); addr != "" {
		return normalizeMinioAddress(addr)
	}
	if addr := os.Getenv("MINIO_ADDRESS"); addr != "" {
		return normalizeMinioAddress(addr)
	}
	return ""
}

func resolveMinioCredentials() (accessKey, secretKey string) {
	accessKey = minioUser
	secretKey = minioPass

	if accessKey == "" {
		accessKey = os.Getenv("MINIO_USER")
	}
	if accessKey == "" {
		accessKey = os.Getenv("MINIO_ACCESS_KEY")
	}

	if secretKey == "" {
		secretKey = os.Getenv("MINIO_PASS")
	}
	if secretKey == "" {
		secretKey = os.Getenv("MINIO_SECRET_KEY")
	}

	return accessKey, secretKey
}

func normalizeMinioAddress(addr string) string {
	addr = strings.TrimSpace(addr)
	// Remove scheme if present (e.g. http:// or https://)
	addr = strings.TrimPrefix(addr, "http://")
	addr = strings.TrimPrefix(addr, "https://")
	addr = strings.TrimSuffix(addr, "/")

	if addr == "" {
		return ""
	}
	// If user passed just a port number, treat it as "127.0.0.1:port"
	if !strings.Contains(addr, ":") {
		return "127.0.0.1:" + addr
	}
	return addr
}

func corsMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
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
		log.Printf("[preview] missing bucket or object params")
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

	// Resolve MinIO address for backend use
	backendMinioAddr := resolveMinioAddress()
	usingBackendMinio := backendMinioAddr != ""

	minioEndpoint := backendMinioAddr
	if minioEndpoint == "" {
		minioEndpoint = getHeader(r, "X-Minio-Endpoint", "127.0.0.1:7000")
	}

	// Resolve credentials: always prefer backend --user/--pass when --minio is configured.
	// Never use credentials sent from the frontend if backend config is active.
	accessKey, secretKey := resolveMinioCredentials()
	usingBackendCreds := accessKey != "" && secretKey != ""

	if !usingBackendCreds && !usingBackendMinio {
		// Legacy fallback only when no backend MinIO config at all
		accessKey = getHeader(r, "X-Minio-Access-Key", "")
		secretKey = getHeader(r, "X-Minio-Secret-Key", "")
		usingBackendCreds = false
	}

	useSSL := strings.ToLower(getHeader(r, "X-Minio-Use-SSL", "false")) == "true"

	log.Printf("[preview] request: bucket=%q object=%q width=%d endpoint=%q useSSL=%v usingBackendMinio=%v usingBackendCreds=%v",
		bucket, object, width, minioEndpoint, useSSL, usingBackendMinio, usingBackendCreds)

	// Debug: log headers when DEBUG_PREVIEW is set
	if os.Getenv("DEBUG_PREVIEW") != "" {
		log.Printf("[preview][debug] X-Minio-Endpoint (header): %s", getHeader(r, "X-Minio-Endpoint", ""))
		log.Printf("[preview][debug] X-Minio-Use-SSL: %s", getHeader(r, "X-Minio-Use-SSL", ""))
		log.Printf("[preview][debug] backendMinioAddr=%q usingBackendMinio=%v", backendMinioAddr, usingBackendMinio)
		log.Printf("[preview][debug] using backend creds (from flag/env): %v", usingBackendCreds)
	}

	if accessKey == "" || secretKey == "" {
		log.Printf("[preview] error: missing minio credentials (endpoint=%s)", minioEndpoint)
		http.Error(w, "missing minio credentials", http.StatusUnauthorized)
		return
	}

	client, err := newMinioClient(minioEndpoint, accessKey, secretKey, useSSL)
	if err != nil {
		log.Printf("[preview] error: failed to create minio client for %s: %v", minioEndpoint, err)
		http.Error(w, "failed to connect to minio: "+err.Error(), http.StatusBadGateway)
		return
	}
	log.Printf("[preview] minio client created successfully for endpoint=%s (backendCreds=%v)", minioEndpoint, usingBackendCreds)

	// Get object info for better caching (ETag)
	log.Printf("[preview] calling StatObject for %s/%s", bucket, object)
	objInfo, err := client.StatObject(ctx, bucket, object, minio.StatObjectOptions{})
	if err != nil {
		log.Printf("[preview] StatObject failed for %s/%s on %s: %v", bucket, object, minioEndpoint, err)
		http.Error(w, "object not found: "+err.Error(), http.StatusNotFound)
		return
	}
	log.Printf("[preview] StatObject success: etag=%s size=%d", objInfo.ETag, objInfo.Size)

	cacheKey := makeCacheKey(minioEndpoint, bucket, object, objInfo.ETag, width)
	previewPath := filepath.Join(cacheDir, cacheKey+".jpg")

	// Serve from cache if exists
	if fi, err := os.Stat(previewPath); err == nil && fi.Size() > 0 {
		log.Printf("[preview] cache hit for %s/%s (key=%s)", bucket, object, cacheKey)
		w.Header().Set("Content-Type", "image/jpeg")
		w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
		w.Header().Set("ETag", fmt.Sprintf(`"%s"`, cacheKey))
		http.ServeFile(w, r, previewPath)
		return
	}
	log.Printf("[preview] cache miss for %s/%s (key=%s)", bucket, object, cacheKey)

	// Fetch original
	log.Printf("[preview] fetching original object %s/%s from MinIO", bucket, object)
	obj, err := client.GetObject(ctx, bucket, object, minio.GetObjectOptions{})
	if err != nil {
		log.Printf("[preview] GetObject failed for %s/%s: %v", bucket, object, err)
		http.Error(w, "failed to get object: "+err.Error(), http.StatusBadGateway)
		return
	}
	defer obj.Close()

	// Decode image
	log.Printf("[preview] decoding image %s/%s", bucket, object)
	src, format, err := image.Decode(obj)
	if err != nil {
		// Try to decode as-is with imaging (more tolerant)
		_, _ = obj.Seek(0, io.SeekStart)
		src, err = imaging.Decode(obj)
		format = "unknown"
	}
	if err != nil {
		log.Printf("[preview] image decode failed for %s/%s (format=%s): %v", bucket, object, format, err)
		http.Error(w, "unsupported image format or decode error", http.StatusUnsupportedMediaType)
		return
	}
	log.Printf("[preview] decoded %s/%s as %s", bucket, object, format)

	// Resize (fit within width, keep aspect)
	dst := imaging.Fit(src, width, width*2, imaging.Lanczos) // generous height

	// Write to temp file then atomic rename
	tmpPath := previewPath + ".tmp"
	out, err := os.Create(tmpPath)
	if err != nil {
		log.Printf("[preview] failed to create temp file: %v", err)
		http.Error(w, "cache write error", http.StatusInternalServerError)
		return
	}

	err = imaging.Encode(out, dst, imaging.JPEG, imaging.JPEGQuality(jpegQuality))
	closeErr := out.Close()

	if err != nil || closeErr != nil {
		_ = os.Remove(tmpPath)
		log.Printf("[preview] encode failed for %s/%s: %v", bucket, object, err)
		http.Error(w, "encode error", http.StatusInternalServerError)
		return
	}

	if err := os.Rename(tmpPath, previewPath); err != nil {
		_ = os.Remove(tmpPath)
		log.Printf("[preview] failed to rename temp file: %v", err)
		http.Error(w, "cache save error", http.StatusInternalServerError)
		return
	}

	log.Printf("[preview] successfully generated and cached preview for %s/%s", bucket, object)

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

func newMadminClient(endpoint, accessKey, secretKey string, useSSL bool) (*madmin.AdminClient, error) {
	client, err := madmin.New(endpoint, accessKey, secretKey, useSSL)
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

// adminCreateUserHandler creates a new MinIO user with their own bucket (versioned) + access to "shared"
func adminCreateUserHandler(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()

	var req struct {
		Username        string `json:"username"`
		Password        string `json:"password"`
		ConfirmPassword string `json:"confirmPassword"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "invalid request body", http.StatusBadRequest)
		return
	}

	if req.Username == "" || req.Password == "" || req.Password != req.ConfirmPassword {
		http.Error(w, "username and matching passwords are required", http.StatusBadRequest)
		return
	}

	// Resolve MinIO address and credentials for backend use.
	// Prefer --minio / --user / --pass (or MINIO_* env) so the backend dials an address
	// it can actually reach (e.g. 127.0.0.1 or internal name), not the browser's view of the endpoint.
	backendMinioAddr := resolveMinioAddress()
	usingBackendMinio := backendMinioAddr != ""

	minioEndpoint := backendMinioAddr
	if minioEndpoint == "" {
		minioEndpoint = getHeader(r, "X-Minio-Endpoint", "")
	}

	accessKey, secretKey := resolveMinioCredentials()
	usingBackendCreds := accessKey != "" && secretKey != ""

	if !usingBackendCreds && !usingBackendMinio {
		// Legacy fallback only when no backend MinIO config at all
		accessKey = getHeader(r, "X-Minio-Access-Key", "")
		secretKey = getHeader(r, "X-Minio-Secret-Key", "")
	}

	useSSL := strings.ToLower(getHeader(r, "X-Minio-Use-SSL", "false")) == "true"

	log.Printf("[admin-create-user] request: username=%q endpoint=%q useSSL=%v usingBackendMinio=%v usingBackendCreds=%v",
		req.Username, minioEndpoint, useSSL, usingBackendMinio, usingBackendCreds)

	if minioEndpoint == "" || accessKey == "" || secretKey == "" {
		log.Printf("[admin-create-user] error: missing minio endpoint or credentials")
		http.Error(w, "missing minio admin credentials (provide via headers or backend --minio/--user/--pass)", http.StatusUnauthorized)
		return
	}

	minioClient, err := newMinioClient(minioEndpoint, accessKey, secretKey, useSSL)
	if err != nil {
		log.Printf("[admin-create-user] error: failed to create minio client for %s: %v", minioEndpoint, err)
		http.Error(w, "failed to connect to minio: "+err.Error(), http.StatusBadGateway)
		return
	}
	log.Printf("[admin-create-user] minio client created for endpoint=%s", minioEndpoint)

	mdm, err := newMadminClient(minioEndpoint, accessKey, secretKey, useSSL)
	if err != nil {
		log.Printf("[admin-create-user] error: failed to create madmin client for %s: %v", minioEndpoint, err)
		http.Error(w, "failed to connect to minio admin: "+err.Error(), http.StatusBadGateway)
		return
	}
	log.Printf("[admin-create-user] madmin client created for endpoint=%s", minioEndpoint)

	// 1. Fail if user's bucket already exists
	log.Printf("[admin-create-user] checking if bucket %q exists...", req.Username)
	t := time.Now()
	exists, err := minioClient.BucketExists(ctx, req.Username)
	log.Printf("[admin-create-user] BucketExists(%q) took %v, exists=%v, err=%v", req.Username, time.Since(t), exists, err)
	if err != nil {
		http.Error(w, "failed to check bucket existence: "+err.Error(), http.StatusInternalServerError)
		return
	}
	log.Printf("[admin-create-user] bucket %q exists=%v", req.Username, exists)
	if exists {
		http.Error(w, "bucket already exists", http.StatusConflict)
		return
	}

	// 2. Create user's bucket + enable versioning
	log.Printf("[admin-create-user] creating bucket %q", req.Username)
	t = time.Now()
	err = minioClient.MakeBucket(ctx, req.Username, minio.MakeBucketOptions{})
	log.Printf("[admin-create-user] MakeBucket(%q) took %v, err=%v", req.Username, time.Since(t), err)
	if err != nil {
		http.Error(w, "failed to create bucket: "+err.Error(), http.StatusInternalServerError)
		return
	}
	log.Printf("[admin-create-user] bucket %q created, enabling versioning", req.Username)
	t = time.Now()
	err = minioClient.SetBucketVersioning(ctx, req.Username, minio.BucketVersioningConfiguration{Status: "Enabled"})
	log.Printf("[admin-create-user] SetBucketVersioning(%q) took %v, err=%v", req.Username, time.Since(t), err)
	if err != nil {
		log.Printf("[admin-create-user] warning: could not enable versioning on %s: %v", req.Username, err)
	}

	// 3. Ensure "shared" bucket exists + versioning
	log.Printf("[admin-create-user] ensuring shared bucket exists and is versioned")
	t = time.Now()
	sharedExists, err := minioClient.BucketExists(ctx, "shared")
	log.Printf("[admin-create-user] BucketExists(shared) took %v, exists=%v, err=%v", time.Since(t), sharedExists, err)
	if err != nil {
		http.Error(w, "failed to check shared bucket: "+err.Error(), http.StatusInternalServerError)
		return
	}
	if !sharedExists {
		log.Printf("[admin-create-user] creating shared bucket")
		t = time.Now()
		err = minioClient.MakeBucket(ctx, "shared", minio.MakeBucketOptions{})
		log.Printf("[admin-create-user] MakeBucket(shared) took %v, err=%v", time.Since(t), err)
		if err != nil {
			http.Error(w, "failed to create shared bucket: "+err.Error(), http.StatusInternalServerError)
			return
		}
	}
	t = time.Now()
	err = minioClient.SetBucketVersioning(ctx, "shared", minio.BucketVersioningConfiguration{Status: "Enabled"})
	log.Printf("[admin-create-user] SetBucketVersioning(shared) took %v, err=%v", time.Since(t), err)
	if err != nil {
		log.Printf("[admin-create-user] warning: could not enable versioning on shared: %v", err)
	}

	// 4. Create policy that gives full access only to own bucket + shared
	policyName := "policy-" + req.Username
	policyDoc := fmt.Sprintf(`{
		"Version": "2012-10-17",
		"Statement": [
			{
				"Effect": "Allow",
				"Action": ["s3:*"],
				"Resource": [
					"arn:aws:s3:::%s",
					"arn:aws:s3:::%s/*",
					"arn:aws:s3:::shared",
					"arn:aws:s3:::shared/*"
				]
			}
		]
	}`, req.Username, req.Username)

	log.Printf("[admin-create-user] creating policy %q", policyName)
	t = time.Now()
	err = mdm.AddCannedPolicy(ctx, policyName, []byte(policyDoc))
	log.Printf("[admin-create-user] AddCannedPolicy(%q) took %v, err=%v", policyName, time.Since(t), err)
	if err != nil {
		http.Error(w, "failed to create policy: "+err.Error(), http.StatusInternalServerError)
		return
	}
	log.Printf("[admin-create-user] policy %q created", policyName)

	// 5. Create the user
	log.Printf("[admin-create-user] creating user %q", req.Username)
	t = time.Now()
	err = mdm.AddUser(ctx, req.Username, req.Password)
	log.Printf("[admin-create-user] AddUser(%q) took %v, err=%v", req.Username, time.Since(t), err)
	if err != nil {
		http.Error(w, "failed to create user: "+err.Error(), http.StatusInternalServerError)
		return
	}
	log.Printf("[admin-create-user] user %q created", req.Username)

	// 6. Attach the policy to the user
	log.Printf("[admin-create-user] attaching policy %q to user %q", policyName, req.Username)
	t = time.Now()
	err = mdm.SetPolicy(ctx, policyName, req.Username, false)
	log.Printf("[admin-create-user] SetPolicy(%q -> %q) took %v, err=%v", policyName, req.Username, time.Since(t), err)
	if err != nil {
		http.Error(w, "failed to attach policy to user: "+err.Error(), http.StatusInternalServerError)
		return
	}
	log.Printf("[admin-create-user] policy attached successfully")

	w.WriteHeader(http.StatusCreated)
	w.Write([]byte(`{"message":"user and bucket created successfully"}`))
	log.Printf("[admin-create-user] success for username=%q", req.Username)
}

