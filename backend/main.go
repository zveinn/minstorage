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
	"net/http/httputil"
	"net/url"
	"os"
	"path/filepath"
	"context"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/disintegration/imaging"
	"github.com/google/uuid"
	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"
	minio "github.com/minio/minio-go/v7"
	"github.com/minio/minio-go/v7/pkg/credentials"
	madmin "github.com/minio/madmin-go/v3"

	"golang.org/x/crypto/acme/autocert"
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

// In-memory one-time signup tokens (UUID -> expiry)
var (
	signupTokens = make(map[string]time.Time)
	signupMu     sync.Mutex
)

// getSignupTokensPath returns the signup-token store location. It is always
// ./signup-tokens.json relative to the working directory, so the `signup`
// subcommand and the running server always agree on a single file — regardless
// of PREVIEW_CACHE_DIR or wherever the previews cache lives. (These are
// intentionally decoupled: they used to derive from cacheDir, which differed
// between the two processes and left generated tokens unredeemable.)
func getSignupTokensPath() string {
	return "signup-tokens.json"
}

func loadSignupTokens() {
	path := getSignupTokensPath()
	data, err := os.ReadFile(path)
	if err != nil {
		return // file may not exist yet
	}
	var onDisk map[string]time.Time
	if err := json.Unmarshal(data, &onDisk); err != nil {
		log.Printf("[signup] warning: could not parse tokens file: %v", err)
		return
	}

	log.Printf("[signup] loaded %d token(s) from %s", len(onDisk), path)

	signupMu.Lock()
	defer signupMu.Unlock()

	now := time.Now()
	// Merge non-expired from disk into memory
	for k, exp := range onDisk {
		if !now.After(exp) {
			signupTokens[k] = exp
		}
	}
	// Prune expired from memory
	for k, exp := range signupTokens {
		if now.After(exp) {
			delete(signupTokens, k)
		}
	}
}

func saveSignupTokens() {
	signupMu.Lock()
	toSave := make(map[string]time.Time)
	now := time.Now()
	for k, exp := range signupTokens {
		if !now.After(exp) {
			toSave[k] = exp
		}
	}
	signupMu.Unlock()

	path := getSignupTokensPath()
	data, err := json.MarshalIndent(toSave, "", "  ")
	if err != nil {
		log.Printf("[signup] warning: could not marshal tokens: %v", err)
		return
	}
	if err := os.WriteFile(path, data, 0644); err != nil {
		log.Printf("[signup] warning: could not write tokens file: %v", err)
	}
}

func main() {
	// Support "signup" subcommand. We scan for the token so that global flags
	// can appear before or after "signup" (e.g. ./backend --signupHostPort x signup --minio y)
	hasSignup := false
	for _, a := range os.Args {
		if a == "signup" {
			hasSignup = true
			break
		}
	}
	if hasSignup {
		// Build arg list with the "signup" token removed so flag.Parse sees all --flags
		cleanArgs := []string{os.Args[0]}
		for _, a := range os.Args[1:] {
			if a != "signup" {
				cleanArgs = append(cleanArgs, a)
			}
		}
		os.Args = cleanArgs
		flag.Parse()
		runSignupCommand()
		return
	}

	flag.Parse()

	cacheDir = os.Getenv("PREVIEW_CACHE_DIR")
	if cacheDir == "" {
		cacheDir = defaultCacheDir
	}
	if err := os.MkdirAll(cacheDir, 0755); err != nil {
		log.Fatalf("failed to create cache dir: %v", err)
	}

	// Load any persisted signup tokens (from previous `./backend signup` runs)
	loadSignupTokens()
	saveSignupTokens() // prune any expired ones on startup
	log.Printf("[signup] loaded signup tokens on startup (will re-load on demand for requests)")

	// Also ensure the embedded static dir exists in source (for dev)
	_ = os.MkdirAll("static", 0755)

	r := chi.NewRouter()
	r.Use(middleware.RequestID)
	r.Use(middleware.RealIP)
	r.Use(middleware.Logger)
	r.Use(middleware.Recoverer)

	// Public one-time signup routes (token-protected self signup, no auth headers required)
	r.Get("/signup/{token}", signupFormHandler)
	r.Post("/signup/{token}", signupSubmitHandler)

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
	effectiveMinio := resolveMinioAddress()

	// Wrap the app router with the transparent S3 proxy. When --minio is set,
	// browser S3 calls (signed with this backend as the endpoint) are forwarded
	// to MinIO with their signature intact, so the UI never talks to MinIO
	// directly and MinIO needs no CORS config of its own.
	var rootHandler http.Handler = r
	if effectiveMinio != "" {
		proxy := newS3Proxy(effectiveMinio, resolveMinioTLS())
		rootHandler = s3ProxyRouter(proxy, r)
		log.Printf("[s3proxy] transparent S3 proxy enabled -> %s (tls=%v)", effectiveMinio, resolveMinioTLS())
	} else {
		log.Printf("[s3proxy] disabled: no --minio address set; the browser must reach MinIO directly")
	}

	if effectiveMinio == "" {
		effectiveMinio = "(per-request from client)"
	}

	effectiveSignup := resolveSignupHostPort()
	if effectiveSignup == "" {
		effectiveSignup = effectiveMinio
	}

	ak, sk := resolveMinioCredentials()
	backendCreds := "no"
	if ak != "" && sk != "" {
		backendCreds = "yes"
	}

	if certDomain == "" {
		certDomain = os.Getenv("CERT_DOMAIN")
	}
	if certDomain == "" {
		certDomain = os.Getenv("CERT")
	}

	if certDomain != "" {
		// Let's Encrypt auto-cert + auto-renewal using golang.org/x/crypto/acme/autocert
		certCache := filepath.Join(cacheDir, "autocert")
		if err := os.MkdirAll(certCache, 0700); err != nil {
			log.Fatalf("failed to create autocert cache dir: %v", err)
		}

		certManager := &autocert.Manager{
			Prompt:     autocert.AcceptTOS,
			HostPolicy: autocert.HostWhitelist(certDomain),
			Cache:      autocert.DirCache(certCache),
		}

		// Start HTTP server on port 80 to handle ACME challenges (required for http-01).
		// Non-challenge requests are redirected to HTTPS.
		go func() {
			redirectToHTTPS := func(w http.ResponseWriter, req *http.Request) {
				target := "https://" + req.Host + req.URL.RequestURI()
				http.Redirect(w, req, target, http.StatusMovedPermanently)
			}
			challengeHandler := certManager.HTTPHandler(http.HandlerFunc(redirectToHTTPS))
			log.Printf("[cert] ACME HTTP-01 challenge server listening on :80 for domain %s", certDomain)
			if err := http.ListenAndServe(":80", challengeHandler); err != nil {
				log.Printf("[cert] challenge server error (may be expected if not root or port in use): %v", err)
			}
		}()

		// Determine HTTPS listen address. Prefer :443 unless user overrode --address to something else.
		httpsAddr := addr
		if addr == defaultAddress || addr == "" {
			httpsAddr = ":443"
		}

		log.Printf("Family Storage listening on %s (HTTPS with auto cert for %s, preview cache: %s, minio: %s, signup: %s, backend-creds: %s)",
			httpsAddr, certDomain, cacheDir, effectiveMinio, effectiveSignup, backendCreds)

		server := &http.Server{
			Addr:      httpsAddr,
			Handler:   rootHandler,
			TLSConfig: certManager.TLSConfig(),
		}
		// ListenAndServeTLS with empty strings uses the TLSConfig from autocert (loads or obtains cert)
		if err := server.ListenAndServeTLS("", ""); err != nil {
			log.Fatal(err)
		}
		return // not reached
	}

	// Plain HTTP mode (no --cert)
	log.Printf("Family Storage listening on %s (preview cache: %s, minio: %s, signup: %s, backend-creds: %s)", addr, cacheDir, effectiveMinio, effectiveSignup, backendCreds)
	if err := http.ListenAndServe(addr, rootHandler); err != nil {
		log.Fatal(err)
	}
}

var listenAddress string
var minioAddress string
var minioUser string
var minioPass string
var minioTLS bool
var signupHostPort string
var certDomain string

func init() {
	flag.StringVar(&listenAddress, "address", "", "Address to listen on (e.g. :8080, 0.0.0.0:8080, 127.0.0.1:9000)")
	flag.StringVar(&listenAddress, "a", "", "Shorthand for --address")

	flag.StringVar(&minioAddress, "minio", "", "MinIO server address (host:port) for the backend to use when talking to MinIO")
	flag.StringVar(&minioAddress, "m", "", "Shorthand for --minio")

	flag.StringVar(&minioUser, "user", "", "MinIO access key for backend operations")
	flag.StringVar(&minioUser, "u", "", "Shorthand for --user")

	flag.StringVar(&minioPass, "pass", "", "MinIO secret key for backend operations")
	flag.StringVar(&minioPass, "p", "", "Shorthand for --pass")

	flag.BoolVar(&minioTLS, "minio-tls", false, "Connect to MinIO over HTTPS/TLS (transparent S3 proxy and previews). Overridden by an explicit scheme on --minio (e.g. https://host). Use --minio-tls=true (the bare form '--minio-tls true' won't work). Also MINIO_TLS=true.")

	flag.StringVar(&signupHostPort, "signupHostPort", "", "Host:port to use in generated signup URLs (e.g. 192.168.1.35:8080). Falls back to --minio address if unset.")

	flag.StringVar(&certDomain, "cert", "", "Domain for automatic Let's Encrypt HTTPS cert (e.g. meow.com). If set, auto-loads or obtains cert + enables auto-renewal via ACME. Serves challenges on :80 and HTTPS on resolved address (defaults to :443).")
	flag.StringVar(&certDomain, "c", "", "Shorthand for --cert")
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
	return normalizeMinioAddress(rawMinioAddress())
}

func resolveMinioTLS() bool {
	// An explicit scheme on the --minio address wins — it's the least
	// surprising signal (e.g. --minio https://… enables TLS, http:// disables
	// it) and sidesteps the `flag` package's boolean gotcha where
	// `--minio-tls false` actually sets the flag to true.
	raw := rawMinioAddress()
	switch {
	case strings.HasPrefix(strings.ToLower(raw), "https://"):
		return true
	case strings.HasPrefix(strings.ToLower(raw), "http://"):
		return false
	}

	if minioTLS {
		return true
	}
	switch strings.ToLower(strings.TrimSpace(os.Getenv("MINIO_TLS"))) {
	case "1", "true", "yes", "on":
		return true
	}
	return false
}

// rawMinioAddress returns the MinIO address as configured, before scheme
// stripping/normalization, so callers can inspect an explicit http(s):// prefix.
func rawMinioAddress() string {
	if minioAddress != "" {
		return minioAddress
	}
	if addr := os.Getenv("MINIO"); addr != "" {
		return addr
	}
	if addr := os.Getenv("MINIO_ADDRESS"); addr != "" {
		return addr
	}
	return ""
}

func resolveSignupHostPort() string {
	if signupHostPort != "" {
		return normalizeMinioAddress(signupHostPort)
	}
	if addr := os.Getenv("SIGNUP_HOST_PORT"); addr != "" {
		return normalizeMinioAddress(addr)
	}
	// Fall back to the minio address (for backward compat)
	return resolveMinioAddress()
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

// newS3Proxy builds a transparent reverse proxy to MinIO.
//
// The browser talks to this backend with the AWS S3 SDK, signing each request
// (SigV4) using THIS backend's host as the endpoint. SigV4 covers the Host
// header and the request path/query, but NOT the URL scheme. So as long as we
// forward the request to MinIO without touching the signed parts — crucially,
// leaving the Host header intact — MinIO recomputes an identical signature
// using the caller's secret key and the request validates. That means we can
// proxy each user's own credentials straight through without re-signing, and
// the backend never needs to know any secret key.
func newS3Proxy(minioAddr string, useTLS bool) *httputil.ReverseProxy {
	scheme := "http"
	if useTLS {
		scheme = "https"
	}
	target := &url.URL{Scheme: scheme, Host: minioAddr}

	return &httputil.ReverseProxy{
		Director: func(req *http.Request) {
			// Only redirect where the bytes are dialed; do NOT modify req.Host.
			// req.Host stays as the inbound (signed) host so MinIO's signature
			// check matches. The X-Forwarded-For header ReverseProxy adds is
			// unsigned and ignored by signature verification.
			req.URL.Scheme = target.Scheme
			req.URL.Host = target.Host
		},
		ErrorHandler: func(w http.ResponseWriter, r *http.Request, err error) {
			log.Printf("[s3proxy] error proxying %s %s: %v", r.Method, r.URL.Path, err)
			http.Error(w, "s3 proxy error: "+err.Error(), http.StatusBadGateway)
		},
	}
}

// isS3Request reports whether a request is an AWS-signed S3 call (either a
// SigV4 Authorization header, or a presigned URL carrying X-Amz-* query
// params). The app's own routes (/health, /preview, /signup, static
// assets, SPA) never carry these, so this cleanly separates S3 traffic from
// app traffic on the same origin/port.
func isS3Request(r *http.Request) bool {
	if strings.HasPrefix(r.Header.Get("Authorization"), "AWS4-HMAC-SHA256") {
		return true
	}
	q := r.URL.Query()
	return q.Get("X-Amz-Signature") != "" || q.Get("X-Amz-Algorithm") != ""
}

// isS3Preflight reports whether a request is a CORS preflight (OPTIONS) for a
// cross-origin S3 call. Preflights don't carry the Authorization header, so
// isS3Request can't see them.
func isS3Preflight(r *http.Request) bool {
	return r.Method == http.MethodOptions &&
		r.Header.Get("Origin") != "" &&
		r.Header.Get("Access-Control-Request-Method") != ""
}

// originMatchesHost reports whether the request Origin's host:port matches the
// host this backend was reached on (the Host header). This restricts the proxy
// to the address the backend is actually being served on — which works even
// when listening on 0.0.0.0, because whatever concrete IP the browser used to
// load the app is the same value in both the Origin and the Host header.
func originMatchesHost(origin, host string) bool {
	u, err := url.Parse(origin)
	if err != nil || u.Host == "" {
		return false
	}
	return strings.EqualFold(u.Host, host)
}

// applyProxyCORS enforces the origin restriction for cross-origin S3 requests
// and answers preflights. Returns true if the caller should continue to the
// proxy, false if the request was fully handled (preflight) or rejected.
func applyProxyCORS(w http.ResponseWriter, r *http.Request) bool {
	origin := r.Header.Get("Origin")
	preflight := isS3Preflight(r)

	// Same-origin (browser omits Origin) or non-browser client: nothing to
	// negotiate. Note the AWS SDK pointed at our own origin never sends Origin.
	if origin == "" {
		if preflight {
			w.WriteHeader(http.StatusNoContent)
			return false
		}
		return true
	}

	// Cross-origin: only allow origins served by this backend.
	if !originMatchesHost(origin, r.Host) {
		log.Printf("[s3proxy] rejected cross-origin request from %q (host=%q)", origin, r.Host)
		http.Error(w, "cross-origin request not allowed", http.StatusForbidden)
		return false
	}

	w.Header().Set("Access-Control-Allow-Origin", origin)
	w.Header().Add("Vary", "Origin")
	w.Header().Set("Access-Control-Allow-Methods", "GET, PUT, POST, DELETE, HEAD, OPTIONS")
	reqHeaders := r.Header.Get("Access-Control-Request-Headers")
	if reqHeaders == "" {
		reqHeaders = "Authorization, Content-Type, Content-MD5, x-amz-content-sha256, x-amz-date, x-amz-user-agent, x-amz-acl, x-amz-meta-*"
	}
	w.Header().Set("Access-Control-Allow-Headers", reqHeaders)
	w.Header().Set("Access-Control-Expose-Headers", "ETag, x-amz-version-id, x-amz-request-id, x-amz-id-2")
	w.Header().Set("Access-Control-Max-Age", "600")

	if preflight {
		w.WriteHeader(http.StatusNoContent)
		return false
	}
	return true
}

// s3ProxyRouter wraps the app router so that S3 traffic is transparently
// forwarded to MinIO and everything else is served normally.
func s3ProxyRouter(proxy *httputil.ReverseProxy, app http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if proxy != nil && (isS3Request(r) || isS3Preflight(r)) {
			if !applyProxyCORS(w, r) {
				return
			}
			proxy.ServeHTTP(w, r)
			return
		}
		app.ServeHTTP(w, r)
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

	if !usingBackendCreds {
		// Fall back to the per-user credentials the browser sends. This keeps
		// previews working in transparent-proxy mode when the backend has a
		// --minio address but no --user/--pass of its own.
		accessKey = getHeader(r, "X-Minio-Access-Key", "")
		secretKey = getHeader(r, "X-Minio-Secret-Key", "")
	}

	// Prefer the backend's TLS setting when talking to a configured MinIO;
	// otherwise honour the per-request header (legacy direct-client mode).
	useSSL := resolveMinioTLS()
	if !usingBackendMinio {
		useSSL = strings.ToLower(getHeader(r, "X-Minio-Use-SSL", "false")) == "true"
	}

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


// --- New signup (one-time link) implementation ---

func runSignupCommand() {
	signupVal := signupHostPort
	if signupVal == "" {
		if v := os.Getenv("SIGNUP_HOST_PORT"); v != "" {
			signupVal = v
		}
	}

	base := resolveSignupHostPort()
	if base == "" {
		base = "127.0.0.1:7000"
	}

	token := uuid.NewString()
	expiry := time.Now().Add(24 * time.Hour)

	loadSignupTokens()
	signupMu.Lock()
	signupTokens[token] = expiry
	signupMu.Unlock()
	saveSignupTokens()
	log.Printf("[signup] stored token %s (valid 24h) in %s", token, getSignupTokensPath())

	signupURL := fmt.Sprintf("http://%s/signup/%s", base, token)

	fmt.Println("One-time signup URL created (valid once):")
	fmt.Println(signupURL)
	fmt.Println()
	if signupVal != "" {
		fmt.Printf("(using --signupHostPort / SIGNUP_HOST_PORT = %s)\n", signupVal)
	} else if minioAddress != "" {
		fmt.Printf("(no --signupHostPort set; fell back to --minio = %s)\n", minioAddress)
	} else {
		fmt.Println("(no --signupHostPort or --minio set; using default)")
	}
	fmt.Println()
	fmt.Println("The user can visit this URL to enter a username and password.")
	fmt.Println("After successful signup the token is consumed.")
}

// isValidSignupToken returns whether the token is still valid (and not expired).
func isValidSignupToken(token string) bool {
	loadSignupTokens()

	signupMu.Lock()
	exp, ok := signupTokens[token]
	expired := ok && time.Now().After(exp)
	if expired {
		delete(signupTokens, token)
	}
	signupMu.Unlock()

	if expired {
		saveSignupTokens()
		return false
	}
	if !ok {
		log.Printf("[signup] token %s NOT FOUND (file checked: %s)", token, getSignupTokensPath())
	}
	return ok
}

// consumeSignupToken removes a token after successful use.
func consumeSignupToken(token string) {
	signupMu.Lock()
	delete(signupTokens, token)
	signupMu.Unlock()
	saveSignupTokens()
}

// createUserAndBucket performs the core work: check/create per-user bucket + versioning,
// ensure shared bucket + versioning, create limited policy, create user, attach policy.
// Always uses backend --minio/--user/--pass credentials.
func createUserAndBucket(username, password string) error {
	if username == "" || password == "" {
		return fmt.Errorf("username and password are required")
	}

	endpoint := resolveMinioAddress()
	if endpoint == "" {
		return fmt.Errorf("minio address not configured (use --minio)")
	}
	accessKey, secretKey := resolveMinioCredentials()
	if accessKey == "" || secretKey == "" {
		return fmt.Errorf("minio admin credentials not configured (use --user/--pass)")
	}
	// Match the TLS setting the rest of the backend uses (https:// scheme on
	// --minio, --minio-tls, or MINIO_TLS). Hardcoding this to false made the
	// signup command speak HTTP to an HTTPS MinIO ("Client sent an HTTP request
	// to an HTTPS server").
	useSSL := resolveMinioTLS()

	log.Printf("[signup] creating clients for endpoint=%s user=%q tls=%v", endpoint, username, useSSL)

	minioClient, err := newMinioClient(endpoint, accessKey, secretKey, useSSL)
	if err != nil {
		return fmt.Errorf("failed to connect to minio: %w", err)
	}
	mdm, err := newMadminClient(endpoint, accessKey, secretKey, useSSL)
	if err != nil {
		return fmt.Errorf("failed to connect to madmin: %w", err)
	}

	ctx := context.Background()

	// 1. Fail if user's bucket already exists
	log.Printf("[signup] checking bucket %q", username)
	exists, err := minioClient.BucketExists(ctx, username)
	if err != nil {
		return fmt.Errorf("failed to check bucket: %w", err)
	}
	if exists {
		return fmt.Errorf("bucket %q already exists", username)
	}

	// 2. Create bucket + versioning
	log.Printf("[signup] creating bucket %q", username)
	if err := minioClient.MakeBucket(ctx, username, minio.MakeBucketOptions{}); err != nil {
		return fmt.Errorf("failed to create bucket: %w", err)
	}
	if err := minioClient.SetBucketVersioning(ctx, username, minio.BucketVersioningConfiguration{Status: "Enabled"}); err != nil {
		log.Printf("[signup] warning: could not enable versioning on %s: %v", username, err)
	}

	// 3. Shared bucket
	log.Printf("[signup] ensuring shared bucket")
	sharedExists, err := minioClient.BucketExists(ctx, "shared")
	if err != nil {
		return fmt.Errorf("failed to check shared: %w", err)
	}
	if !sharedExists {
		if err := minioClient.MakeBucket(ctx, "shared", minio.MakeBucketOptions{}); err != nil {
			return fmt.Errorf("failed to create shared bucket: %w", err)
		}
	}
	if err := minioClient.SetBucketVersioning(ctx, "shared", minio.BucketVersioningConfiguration{Status: "Enabled"}); err != nil {
		log.Printf("[signup] warning: could not enable versioning on shared: %v", err)
	}

	// 4. Policy limited to user's bucket + shared
	policyName := "policy-" + username
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
	}`, username, username)

	log.Printf("[signup] creating policy %q", policyName)
	if err := mdm.AddCannedPolicy(ctx, policyName, []byte(policyDoc)); err != nil {
		return fmt.Errorf("failed to create policy: %w", err)
	}

	// 5 + 6. User + attach
	log.Printf("[signup] creating user %q", username)
	if err := mdm.AddUser(ctx, username, password); err != nil {
		return fmt.Errorf("failed to create user: %w", err)
	}
	if err := mdm.SetPolicy(ctx, policyName, username, false); err != nil {
		return fmt.Errorf("failed to attach policy: %w", err)
	}

	log.Printf("[signup] success: user=%q", username)
	return nil
}

// --- HTTP handlers for the signup flow ---

func signupFormHandler(w http.ResponseWriter, r *http.Request) {
	token := chi.URLParam(r, "token")
	if !isValidSignupToken(token) {
		log.Printf("[signup] GET /signup/%s rejected as invalid/expired", token)
		http.Error(w, "Invalid or expired signup link.", http.StatusNotFound)
		return
	}

	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	fmt.Fprintf(w, `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<title>Create Account</title>
<style>
body { font-family: system-ui, sans-serif; background: #f9f7f3; margin: 0; padding: 40px 20px; color: #3f2e1e; }
.card { max-width: 420px; margin: 0 auto; background: white; border: 1px solid #d4c5b5; border-radius: 12px; padding: 28px; box-shadow: 0 2px 8px rgba(0,0,0,0.04); }
h1 { margin-top: 0; font-size: 1.4rem; }
label { display: block; font-size: 0.9rem; margin-bottom: 4px; font-weight: 500; }
input { width: 100%%; padding: 10px 12px; border: 1px solid #d4c5b5; border-radius: 8px; margin-bottom: 14px; font-size: 1rem; box-sizing: border-box; }
button { background: #d4c5b5; color: #3f2e1e; border: none; padding: 12px 20px; border-radius: 8px; font-size: 1rem; cursor: pointer; width: 100%%; }
button:hover { background: #c3b3a3; }
.error { color: #b33; font-size: 0.9rem; margin-bottom: 12px; }
.hint { font-size: 0.8rem; color: #6b5b4a; margin-top: 16px; }
</style>
</head>
<body>
<div class="card">
<h1>Create your account</h1>
<form method="POST" action="/signup/%s">
<label>Username</label>
<input name="username" required autocomplete="username" placeholder="yourname">
<label>Password</label>
<input name="password" type="password" required autocomplete="new-password">
<label>Confirm Password</label>
<input name="confirmPassword" type="password" required autocomplete="new-password">
<button type="submit">Create Account &amp; Bucket</button>
</form>
<p class="hint">Your own private versioned bucket will be created. You will also get access to the "shared" bucket.</p>
</div>
</body>
</html>`, token)
}

func signupSubmitHandler(w http.ResponseWriter, r *http.Request) {
	token := chi.URLParam(r, "token")
	if !isValidSignupToken(token) {
		log.Printf("[signup] POST /signup/%s rejected as invalid/expired", token)
		http.Error(w, "Invalid or expired signup link.", http.StatusNotFound)
		return
	}

	if err := r.ParseForm(); err != nil {
		http.Error(w, "bad form", http.StatusBadRequest)
		return
	}

	username := strings.TrimSpace(r.FormValue("username"))
	password := r.FormValue("password")
	confirm := r.FormValue("confirmPassword")

	if username == "" || password == "" || password != confirm {
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		fmt.Fprint(w, `<!doctype html><html><body><h3>Error</h3><p>Username and matching passwords are required.</p><p><a href="javascript:history.back()">Go back</a></p></body></html>`)
		return
	}

	err := createUserAndBucket(username, password)
	if err != nil {
		log.Printf("[signup] create failed for %q: %v", username, err)
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		fmt.Fprintf(w, `<!doctype html><html><body><h3>Could not create account</h3><p>%s</p><p><a href="javascript:history.back()">Try again</a></p></body></html>`, err.Error())
		return
	}

	// Success: consume token
	consumeSignupToken(token)

	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	fmt.Fprintf(w, `<!doctype html>
<html><head><meta charset="utf-8"><title>Account Created</title>
<style>body{font-family:system-ui;background:#f9f7f3;padding:40px;color:#3f2e1e} .card{max-width:420px;margin:0 auto;background:white;border:1px solid #d4c5b5;border-radius:12px;padding:28px}</style>
</head><body>
<div class="card">
<h1>Account created!</h1>
<p>Your username <strong>%s</strong> has been created along with your private bucket and access to "shared".</p>
<p>You can now log in to the main storage interface using your new credentials.</p>
<p><a href="/">Go to login</a></p>
</div>
</body></html>`, username)
}

