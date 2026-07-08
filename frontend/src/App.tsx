import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  S3Client,
  ListBucketsCommand,
  ListObjectsV2Command,
  ListObjectVersionsCommand,
  DeleteObjectCommand,
  CopyObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  GetObjectTaggingCommand,
  PutObjectTaggingCommand,
} from '@aws-sdk/client-s3'
import { Upload } from '@aws-sdk/lib-storage'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import { XhrHttpHandler } from '@aws-sdk/xhr-http-handler'
import {
  Upload as UploadIcon, Download, Trash2, Folder, File, Image as ImageIcon,
  LogOut, ChevronRight, ChevronLeft, X, Check, Eye, EyeOff, RotateCcw, Link, FolderPlus, FolderUp, MessageSquare,
  LayoutGrid, List, Menu, Sun, Moon, Search, Users, Database, Pencil
} from 'lucide-react'
import { format } from 'date-fns'
import { toast } from 'sonner'
import './App.css'

// Types
interface Credentials {
  accessKey: string
  secretKey: string
}

interface FileItem {
  name: string
  fullPath: string
  size: number
  lastModified?: Date
  isDir: boolean
  isDeleted?: boolean
  versionId?: string
  // True when this item represents a whole bucket shown as a folder in the
  // "root" view (admins with more than two buckets land here on login).
  isBucket?: boolean
}



const IMAGE_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.svg', '.avif']

function isImage(filename: string): boolean {
  const lower = filename.toLowerCase()
  return IMAGE_EXTENSIONS.some(ext => lower.endsWith(ext))
}

function formatSize(bytes: number): string {
  if (bytes === 0) return '0 B'
  const k = 1024
  const sizes = ['B', 'KB', 'MB', 'GB']
  const i = Math.floor(Math.log(bytes) / Math.log(k))
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i]
}

function getS3Client(creds: Credentials) {
  // Talk to MinIO through our own Go backend (transparent S3 proxy) on the same
  // origin that served this app. The backend forwards each request to MinIO
  // without re-signing — SigV4 covers the Host header (this backend's host) and
  // the path, but not the scheme — so per-user credentials still validate. This
  // means the browser never connects to MinIO directly and MinIO needs no CORS
  // config of its own.
  return new S3Client({
    endpoint: window.location.origin,
    region: 'us-east-1',
    credentials: {
      accessKeyId: creds.accessKey,
      secretAccessKey: creds.secretKey,
    },
    forcePathStyle: true,
    // Use XMLHttpRequest instead of fetch so uploads emit real-time byte-level
    // progress (the Fetch API has no upload progress events, which made the
    // progress bar jump straight to 100% or never appear on slow connections).
    requestHandler: new XhrHttpHandler({}),
  })
}

async function listObjectsWithPrefix(
  client: S3Client,
  bucket: string,
  prefix: string,
  showDeleted: boolean = false
): Promise<{ files: any[]; prefixes: string[] }> {
  const allFiles: any[] = []
  const prefixSet = new Set<string>()

  if (!showDeleted) {
    let continuationToken: string | undefined
    let isTruncated = true
    while (isTruncated) {
      const command = new ListObjectsV2Command({
        Bucket: bucket,
        Prefix: prefix,
        Delimiter: '/',
        ContinuationToken: continuationToken,
      })

      const response = await client.send(command)

      ;(response.CommonPrefixes || []).forEach((p) => {
        if (p.Prefix && p.Prefix !== prefix) prefixSet.add(p.Prefix)
      })

      ;(response.Contents || []).forEach((obj) => {
        if (obj.Key && obj.Key !== prefix) {
          allFiles.push({
            name: obj.Key,
            size: obj.Size || 0,
            etag: obj.ETag || '',
            lastModified: obj.LastModified,
            isDeleted: false,
          })
        }
      })

      continuationToken = response.NextContinuationToken
      isTruncated = !!response.IsTruncated
    }
  } else {
    // Show deleted: use versions + delete markers (marker-based pagination)
    let keyMarker: string | undefined
    let versionIdMarker: string | undefined
    let isTruncated = true

    while (isTruncated) {
      const command = new ListObjectVersionsCommand({
        Bucket: bucket,
        Prefix: prefix,
        Delimiter: '/',
        KeyMarker: keyMarker,
        VersionIdMarker: versionIdMarker,
      })

      const response = await client.send(command)

      ;(response.CommonPrefixes || []).forEach((p) => {
        if (p.Prefix && p.Prefix !== prefix) prefixSet.add(p.Prefix)
      })

      ;(response.Versions || []).forEach((obj: any) => {
        if (obj.Key && obj.Key !== prefix && obj.IsLatest) {
          allFiles.push({
            name: obj.Key,
            size: obj.Size || 0,
            etag: obj.ETag || '',
            lastModified: obj.LastModified,
            isDeleted: false,
          })
        }
      })

      ;(response.DeleteMarkers || []).forEach((dm: any) => {
        if (dm.Key && dm.Key !== prefix && dm.IsLatest) {
          allFiles.push({
            name: dm.Key,
            size: 0,
            etag: '',
            lastModified: dm.LastModified,
            isDeleted: true,
            versionId: dm.VersionId,
          })
        }
      })

      isTruncated = !!response.IsTruncated
      keyMarker = response.NextKeyMarker
      versionIdMarker = response.NextVersionIdMarker
    }
  }

  const prefixes = Array.from(prefixSet).filter(
    (p) => p && p !== prefix && p.startsWith(prefix || '')
  )

  return { files: allFiles, prefixes }
}

async function listBuckets(client: S3Client): Promise<string[]> {
  const response = await client.send(new ListBucketsCommand({}))
  return (response.Buckets || []).map((b) => b.Name!).filter(Boolean).sort()
}

// Strictly-increasing UnixNano stamp. There is no true epoch-nanosecond clock
// in the browser, so we use the highest-resolution one available:
// performance.timeOrigin + performance.now() is a sub-millisecond (often
// microsecond-grade) epoch time. We convert that to nanoseconds and, when two
// files still land on the same value, bump by 1ns — keeping every key unique
// (no overwrites) and monotonic / lexically sortable by upload time.
let lastUploadStamp = 0n
function nowEpochNanos(): bigint {
  const hiresMs =
    typeof performance !== 'undefined' && typeof performance.timeOrigin === 'number'
      ? performance.timeOrigin + performance.now() // sub-ms resolution where the browser allows
      : Date.now() // ms-only fallback
  return BigInt(Math.round(hiresMs * 1e6)) // ms -> ns
}
function nextUploadStamp(): bigint {
  let ts = nowEpochNanos()
  if (ts <= lastUploadStamp) ts = lastUploadStamp + 1n
  lastUploadStamp = ts
  return ts
}

/** Prefixes the name with a UnixNano-style timestamp so object keys sort
 *  lexically by upload time and never overwrite a same-named upload. */
function makeStorageName(originalName: string): string {
  return `${nextUploadStamp()}-${originalName}`
}

/** Removes the leading <unixnano>- timestamp prefix for display purposes. */
function getDisplayName(storageName: string): string {
  // 13+ digits avoids stripping ordinary names that happen to start with a
  // short number (e.g. "2024-report.pdf"); our prefixes are 19 digits.
  return storageName.replace(/^\d{13,}-/, '')
}

function ObjectThumbnail({
  bucket,
  objectName,
  creds,
}: {
  bucket: string
  objectName: string
  creds: Credentials
}) {
  const [url, setUrl] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let objectUrl: string | null = null
    const controller = new AbortController()

    async function load() {
      setLoading(true)
      try {
        // Previews are generated by our Go backend on the same origin. The
        // backend uses its --minio address (and its own --user/--pass when set),
        // falling back to the per-user credentials sent below.
        const urlObj = new URL('/preview', window.location.origin)
        urlObj.searchParams.set('bucket', bucket)
        urlObj.searchParams.set('object', objectName)
        urlObj.searchParams.set('w', '280')

        const res = await fetch(urlObj.toString(), {
          signal: controller.signal,
          headers: {
            'X-Minio-Access-Key': creds.accessKey,
            'X-Minio-Secret-Key': creds.secretKey,
          },
        })

        if (!res.ok) throw new Error('preview failed')

        const blob = await res.blob()
        objectUrl = URL.createObjectURL(blob)
        setUrl(objectUrl)
      } catch {
        setUrl(null)
      } finally {
        setLoading(false)
      }
    }
    load()

    return () => {
      controller.abort()
      if (objectUrl) URL.revokeObjectURL(objectUrl)
    }
  }, [bucket, objectName, creds])

  if (loading) {
    return <div className="thumbnail w-full h-40 bg-beige-100 animate-pulse" />
  }

  if (url) {
    return <img src={url} alt={objectName} className="w-full h-40 object-cover" />
  }

  return (
    <div className="thumbnail w-full h-40 text-beige-600">
      <ImageIcon size={32} />
    </div>
  )
}

function App() {
  const [creds, setCreds] = useState<Credentials | null>(null)
  const [client, setClient] = useState<S3Client | null>(null)

  const [buckets, setBuckets] = useState<string[]>([])
  const [selectedBucket, setSelectedBucket] = useState<string | null>(null)
  const [currentPrefix, setCurrentPrefix] = useState('')
  const [items, setItems] = useState<FileItem[]>([])
  const [loading, setLoading] = useState(false)
  const [search, setSearch] = useState('')
  const [searchType, setSearchType] = useState<'name' | 'note'>('name')
  const [showDeleted, setShowDeleted] = useState(false)
  const [showNotes, setShowNotes] = useState(false)
  const [viewMode, setViewMode] = useState<'grid' | 'list'>('grid')
  const [pageSize, setPageSize] = useState<100 | 200 | 400 | 'all'>(100)
  const [currentPage, setCurrentPage] = useState(1)
  const [notes, setNotes] = useState<Record<string, string>>({})
  const [tooltip, setTooltip] = useState<{ text: string; x: number; y: number } | null>(null)
  const [currentUpload, setCurrentUpload] = useState<{
    name: string
    percent: number
    speed: number
    done: number
    total: number
  } | null>(null)
  const [currentDelete, setCurrentDelete] = useState<{
    name: string
    done: number
    total: number
  } | null>(null)
  const [currentRename, setCurrentRename] = useState<{
    name: string
    done: number
    total: number
  } | null>(null)


  const [selectedItems, setSelectedItems] = useState<Set<string>>(new Set())
  const [isDragSelecting, setIsDragSelecting] = useState(false)
  const [dragStartPos, setDragStartPos] = useState({ x: 0, y: 0 })
  const [dragCurrentPos, setDragCurrentPos] = useState({ x: 0, y: 0 })

  const [previewItem, setPreviewItem] = useState<FileItem | null>(null)
  const [previewUrl, setPreviewUrl] = useState<string | null>(null)

  // Share link modal state
  const [shareModalOpen, setShareModalOpen] = useState(false)
  const [shareItem, setShareItem] = useState<FileItem | null>(null)
  const [shareExpirySeconds, setShareExpirySeconds] = useState(3600) // default 1 hour
  const [generatedShareUrl, setGeneratedShareUrl] = useState<string>('')
  const [isGeneratingShare, setIsGeneratingShare] = useState(false)

  // Confirm / prompt dialog state (replaces native window.confirm / window.prompt)
  const [confirmDialog, setConfirmDialog] = useState<{
    title: string
    message: string
    confirmLabel: string
    cancelLabel: string
    danger: boolean
    checkboxLabel?: string
    checked: boolean
    resolve: (result: { confirmed: boolean; checked: boolean }) => void
  } | null>(null)
  const [promptDialog, setPromptDialog] = useState<{
    title: string
    label: string
    placeholder: string
    value: string
    confirmLabel: string
    resolve: (value: string | null) => void
  } | null>(null)

  // Note modal state
  const [noteModalOpen, setNoteModalOpen] = useState(false)
  const [noteItem, setNoteItem] = useState<FileItem | null>(null)
  const [noteText, setNoteText] = useState('')
  const [isLoadingNote, setIsLoadingNote] = useState(false)
  const [isSavingNote, setIsSavingNote] = useState(false)

  const [mobileMenuOpen, setMobileMenuOpen] = useState(false)

  // Theme (light/dark). The initial class is applied pre-paint by an inline
  // script in index.html; we mirror it here and keep it in sync + persisted.
  const [theme, setTheme] = useState<'light' | 'dark'>(() =>
    typeof document !== 'undefined' && document.documentElement.classList.contains('dark') ? 'dark' : 'light'
  )
  useEffect(() => {
    document.documentElement.classList.toggle('dark', theme === 'dark')
    try { localStorage.setItem('minstorage-theme', theme) } catch {}
  }, [theme])
  const toggleTheme = () => setTheme((t) => (t === 'dark' ? 'light' : 'dark'))

  const [loginForm, setLoginForm] = useState({ accessKey: '', secretKey: '' })
  const [showPassword, setShowPassword] = useState(false)

  const isLoggedIn = !!creds && !!client

  // When bucket changes, reset notes (sidebar tree logic removed)
  useEffect(() => {
    if (selectedBucket && client) {
      setNotes({})
    }
  }, [selectedBucket, client])

  const STORAGE_KEY = 'FAMILY_STORAGE_CREDS'
  const STORAGE_STATE_KEY = 'FAMILY_STORAGE_STATE'

  // Becomes true once login/restore has settled on a location. Until then we
  // must NOT persist UI state, otherwise the brief "logged-in but no bucket
  // yet" window on mount would clobber the saved state before restore reads it.
  const sessionReadyRef = useRef(false)

  // Restore credentials from sessionStorage on mount
  useEffect(() => {
    const stored = sessionStorage.getItem(STORAGE_KEY)
    if (!stored) return

    try {
      const parsed: Credentials = JSON.parse(stored)
      const s3Client = getS3Client(parsed)

      setCreds(parsed)
      setClient(s3Client)

      // Try to restore buckets and UI state (bucket + dir + showDeleted) if possible
      listBuckets(s3Client)
        .then((bucketList) => {
          setBuckets(bucketList)

          // Load persisted UI state
          let targetBucket: string | null = null
          let savedWasRoot = false
          let targetPrefix = ''
          let targetShowDeleted = false
          let targetShowNotes = false
          let targetViewMode: 'grid' | 'list' = 'grid'
          let targetPageSize: 100 | 200 | 400 | 'all' = 100
          let targetCurrentPage = 1
          try {
            const saved = sessionStorage.getItem(STORAGE_STATE_KEY)
            if (saved) {
              const parsedState = JSON.parse(saved)
              if (parsedState.selectedBucket && bucketList.includes(parsedState.selectedBucket)) {
                targetBucket = parsedState.selectedBucket
              } else if (parsedState.selectedBucket === null) {
                // The user was at the "root" view; keep them there on refresh.
                savedWasRoot = true
              }
              if (typeof parsedState.currentPrefix === 'string') {
                targetPrefix = parsedState.currentPrefix
              }
              if (typeof parsedState.showDeleted === 'boolean') {
                targetShowDeleted = parsedState.showDeleted
              }
              if (typeof parsedState.showNotes === 'boolean') {
                targetShowNotes = parsedState.showNotes
              }
              if (parsedState.viewMode === 'list' || parsedState.viewMode === 'grid') {
                targetViewMode = parsedState.viewMode
              }
              if (parsedState.pageSize === 100 || parsedState.pageSize === 200 || parsedState.pageSize === 400 || parsedState.pageSize === 'all') {
                targetPageSize = parsedState.pageSize
              }
              if (typeof parsedState.currentPage === 'number' && parsedState.currentPage > 0) {
                targetCurrentPage = parsedState.currentPage
              }
            }
          } catch {}

          if (bucketList.length > 0) {
            // Set showDeleted and showNotes first so the UI toggle reflects restored state
            if (targetShowDeleted !== showDeleted) {
              setShowDeleted(targetShowDeleted)
            }
            if (targetShowNotes !== showNotes) {
              setShowNotes(targetShowNotes)
            }
            if (targetViewMode !== viewMode) {
              setViewMode(targetViewMode)
            }
            if (targetPageSize !== pageSize) {
              setPageSize(targetPageSize)
            }
            setSearch('')
            setCurrentPage(targetCurrentPage)
            clearSelection()
            // From here on it's safe to persist UI state again.
            sessionReadyRef.current = true

            if (targetBucket) {
              // Reopen the previously selected bucket at its saved prefix.
              setSelectedBucket(targetBucket)
              setCurrentPrefix(targetPrefix)
              loadObjects(targetBucket, targetPrefix, s3Client, parsed, targetShowDeleted).catch(() => {})
            } else if (savedWasRoot) {
              // Saved location was "root" — restore it instead of a bucket.
              setSelectedBucket(null)
              setCurrentPrefix('')
              setItems([])
            } else {
              // No usable saved state: default to the user's personal bucket
              // (named like their login) if it exists, otherwise the "root" view.
              const home = bucketList.find(b => b === parsed.accessKey)
              if (home) {
                setSelectedBucket(home)
                setCurrentPrefix('')
                loadObjects(home, '', s3Client, parsed, targetShowDeleted).catch(() => {})
              } else {
                setSelectedBucket(null)
                setCurrentPrefix('')
                setItems([])
              }
            }

            // (sidebar tree restoration removed)
          }
        })
        .catch((err) => {
          console.error('Failed to restore MinIO session:', err)
          // Stored credentials are no longer valid
          sessionStorage.removeItem(STORAGE_KEY)
          sessionStorage.removeItem(STORAGE_STATE_KEY)
          setCreds(null)
          setClient(null)
          setBuckets([])
        })
    } catch (e) {
      console.error('Invalid stored credentials')
      sessionStorage.removeItem(STORAGE_KEY)
    }
  }, []) // run only once on mount

  // Persist UI state (bucket/dir/show-deleted) so refresh keeps the same view.
  // selectedBucket is null at the "root" view and we persist that too, so a
  // refresh from root stays at root. The sessionReadyRef gate prevents the
  // mount-time "no bucket yet" window from clobbering the saved state.
  useEffect(() => {
    if (isLoggedIn && sessionReadyRef.current) {
      const state = {
        selectedBucket,
        currentPrefix,
        showDeleted,
        showNotes,
        viewMode,
        pageSize,
        currentPage,
      }
      sessionStorage.setItem(STORAGE_STATE_KEY, JSON.stringify(state))
    }
  }, [selectedBucket, currentPrefix, showDeleted, showNotes, viewMode, pageSize, currentPage, isLoggedIn])

  const connect = async (form: typeof loginForm) => {
    if (!form.accessKey || !form.secretKey) {
      toast.error('Please enter your user and password')
      return
    }

    const newCreds: Credentials = {
      accessKey: form.accessKey.trim(),
      secretKey: form.secretKey.trim(),
    }

    try {
      const s3Client = getS3Client(newCreds)
      const bucketList = await listBuckets(s3Client)

      setCreds(newCreds)
      setClient(s3Client)
      setBuckets(bucketList)
      setSelectedBucket(null)
      setItems([])
      setCurrentPrefix('')
      setSearch('')
      setSearchType('name')
      setShowNotes(false)
      setNotes({})
      setViewMode('grid')
      setPageSize(100)
      setCurrentPage(1)
      sessionReadyRef.current = true

      // Default location: the user's personal bucket (named like their login)
      // if it exists, otherwise the "root" view listing all buckets as folders.
      const home = bucketList.find(b => b === newCreds.accessKey)
      if (home) {
        await selectBucket(home, s3Client, newCreds)
      } else if (bucketList.length > 0) {
        setItems([]) // selectedBucket stays null -> root view
      } else {
        toast('Connected. No buckets found.')
      }

      // Persist to sessionStorage so refresh doesn't require re-login
      sessionStorage.setItem(STORAGE_KEY, JSON.stringify(newCreds))

      toast.success('Connected to MinIO')
    } catch (err: any) {
      console.error(err)
      toast.error('Failed to connect: ' + (err.message || 'Check credentials and CORS'))
    }
  }

  const disconnect = () => {
    sessionReadyRef.current = false
    sessionStorage.removeItem(STORAGE_KEY)
    sessionStorage.removeItem(STORAGE_STATE_KEY)
    setCreds(null)
    setClient(null)
    setBuckets([])
    setSelectedBucket(null)
    setItems([])
    setCurrentPrefix('')
    setSearch('')
    setSearchType('name')
    setPreviewItem(null)
    setPreviewUrl(null)
    clearSelection()
    setNotes({})
    setShowNotes(false)
    setViewMode('grid')
    setPageSize(100)
    setCurrentPage(1)
    toast.info('Disconnected')
  }

  const selectBucket = useCallback(async (
    bucket: string,
    c?: S3Client,
    cr?: Credentials
  ) => {
    const activeClient = c || client
    const activeCreds = cr || creds
    if (!activeClient || !activeCreds) return

    setSelectedBucket(bucket)
    setCurrentPrefix('')
    setSearch('')
    setCurrentPage(1)
    clearSelection()
    setMobileMenuOpen(false)
    await loadObjects(bucket, '', activeClient, activeCreds, showDeleted)
  }, [client, creds, showDeleted])

  async function loadObjects(
    bucket: string,
    prefix: string,
    c?: S3Client,
    _cr?: Credentials | null,
    showDel: boolean = showDeleted
  ) {
    const activeClient = c || client
    if (!activeClient) return

    setLoading(true)
    try {
      const { files, prefixes } = await listObjectsWithPrefix(activeClient, bucket, prefix, showDel)

      const fileItems: FileItem[] = [
        ...prefixes.map(p => ({
          name: p.replace(prefix, '').replace(/\/$/, ''),
          fullPath: p,
          size: 0,
          isDir: true,
        })),
        ...files
          .filter(f => f.name !== prefix)
          .map(f => ({
            name: getDisplayName(f.name.replace(prefix, '')),
            fullPath: f.name,
            size: f.size,
            lastModified: f.lastModified,
            isDir: false,
            isDeleted: f.isDeleted || false,
            versionId: f.versionId,
          })),
      ]

      setItems(fileItems)
    } catch (err: any) {
      toast.error('Failed to list objects: ' + (err.message || ''))
      setItems([])
    } finally {
      setLoading(false)
    }
  }

  // Reload listing when showDeleted changes
  useEffect(() => {
    if (selectedBucket && client && creds) {
      setCurrentPage(1)
      loadObjects(selectedBucket, currentPrefix, client, creds, showDeleted)
    }
  }, [showDeleted])

  // Load notes for current items when needed for display or note search
  useEffect(() => {
    if (selectedBucket && client && items.length > 0 && (showNotes || searchType === 'note')) {
      loadNotesForItems(items)
    }
  }, [showNotes, searchType, items, selectedBucket, client])

  // Reset to page 1 on search or page size change
  useEffect(() => {
    setCurrentPage(1)
  }, [search, searchType, pageSize])

  const navigateTo = (prefix: string) => {
    if (!selectedBucket || !client || !creds) return
    setCurrentPrefix(prefix)
    setSearch('')
    setCurrentPage(1)
    clearSelection()
    setMobileMenuOpen(false)
    loadObjects(selectedBucket, prefix, client, creds, showDeleted)
  }

  const goHome = () => {
    if (selectedBucket) {
      setCurrentPage(1)
      setMobileMenuOpen(false)
      navigateTo('')
    }
  }

  // The user's personal bucket is the one named exactly like their login (the
  // access key). It's the default landing spot when present; otherwise we land
  // at "root" (all buckets listed as folders).
  const homeBucket = useMemo(
    () => (creds ? buckets.find(b => b === creds.accessKey) ?? null : null),
    [creds, buckets]
  )

  // Offer "root" navigation whenever there is no personal bucket to call home,
  // or there are enough buckets that browsing them as folders is useful.
  const rootEnabled = !homeBucket || buckets.length > 2

  // Leave the selected bucket and show the "root" view (buckets as folders).
  const goToRoot = () => {
    setSelectedBucket(null)
    setCurrentPrefix('')
    setSearch('')
    setCurrentPage(1)
    setItems([])
    clearSelection()
    setMobileMenuOpen(false)
  }

  const breadcrumbs = useMemo(() => {
    if (!currentPrefix) return []
    const parts = currentPrefix.split('/').filter(Boolean)
    const crumbs: { label: string; prefix: string }[] = []
    let built = ''
    for (const part of parts) {
      built += part + '/'
      crumbs.push({ label: part, prefix: built })
    }
    return crumbs
  }, [currentPrefix])

  // The "root" view lists every bucket as a folder. Clicking one opens it.
  const rootItems = useMemo<FileItem[]>(
    () =>
      buckets.map(b => ({
        name: b,
        fullPath: b,
        size: 0,
        isDir: true,
        isBucket: true,
      })),
    [buckets]
  )

  // No custom sorting: object keys are timestamp-prefixed, so MinIO returns
  // them already ordered by upload time. We only apply the search filter and
  // otherwise keep the list exactly as received (folders first, then files).
  // At root (no bucket selected) we filter over the bucket list instead.
  const filteredItems = useMemo(() => {
    const base = selectedBucket ? items : rootItems
    const q = search.trim().toLowerCase()
    if (!q) return base
    if (searchType === 'note') {
      return base.filter(i => (notes[i.fullPath] || '').toLowerCase().includes(q))
    }
    return base.filter(i => i.name.toLowerCase().includes(q))
  }, [items, rootItems, selectedBucket, search, searchType, notes])

  // Client-side pagination over the filtered results
  const visibleItems = useMemo(() => {
    if (pageSize === 'all') return filteredItems
    const size = pageSize
    const start = Math.max(0, (currentPage - 1) * size)
    return filteredItems.slice(start, start + size)
  }, [filteredItems, pageSize, currentPage])

  const totalPages = useMemo(() => {
    if (pageSize === 'all') return 1
    return Math.max(1, Math.ceil(filteredItems.length / pageSize))
  }, [filteredItems.length, pageSize])

  // Clamp current page if it exceeds total after data changes
  useEffect(() => {
    setCurrentPage((cp) => Math.min(Math.max(1, cp), totalPages))
  }, [totalPages])

  // Images for preview nav are scoped to the current visible page
  const currentImages = useMemo(() => {
    return visibleItems.filter(i => !i.isDir && !i.isDeleted && isImage(i.name))
  }, [visibleItems])

  // For preview nav (computed every render, very cheap)
  const previewIndex = previewItem ? currentImages.findIndex(i => i.fullPath === previewItem.fullPath) : -1
  const previewTotal = currentImages.length

  const contentRef = useRef<HTMLDivElement>(null)

  const isInSelectMode = selectedItems.size > 0
  // Hint for the Delete button label. A file's delete is permanent when it's
  // already deleted. A folder's state depends on its contents (resolved async at
  // delete time), so we don't promise "forever" when folders are selected — the
  // confirm dialog spells out the exact outcome.
  const selectedDeleteIsForce = (() => {
    if (!isInSelectMode) return false
    const sel = items.filter(i => selectedItems.has(i.fullPath))
    return sel.length > 0 && sel.every(i => !i.isDir && i.isDeleted)
  })()

  const loadNotesForItems = async (itemsToLoad: FileItem[]) => {
    if (!selectedBucket || !client) return
    const newNotes = { ...notes }
    const toFetch = itemsToLoad.filter(
      i => !i.isDir && !newNotes.hasOwnProperty(i.fullPath)
    )
    if (toFetch.length === 0) return

    const promises = toFetch.map(async (item) => {
      try {
        const res = await client.send(new GetObjectTaggingCommand({
          Bucket: selectedBucket,
          Key: item.fullPath,
        }))
        const noteTag = res.TagSet?.find(t => t.Key === 'note')
        if (noteTag?.Value) {
          newNotes[item.fullPath] = noteTag.Value
        } else {
          newNotes[item.fullPath] = '' // explicitly no note
        }
      } catch (e) {
        newNotes[item.fullPath] = '' // error or no tags
      }
    })
    await Promise.all(promises)
    setNotes(newNotes)
  }

  const toggleSelect = (fullPath: string) => {
    setSelectedItems(prev => {
      const next = new Set(prev)
      if (next.has(fullPath)) {
        next.delete(fullPath)
      } else {
        next.add(fullPath)
      }
      return next
    })
  }

  const clearSelection = () => {
    setSelectedItems(new Set())
  }

  // Promise-based confirm/prompt backed by in-app modals (below). Replaces the
  // native window.confirm / window.prompt so dialogs match the app's styling.
  const askConfirm = (opts: {
    title: string
    message?: string
    confirmLabel?: string
    cancelLabel?: string
    danger?: boolean
    checkboxLabel?: string
    checkboxDefault?: boolean
  }): Promise<{ confirmed: boolean; checked: boolean }> =>
    new Promise((resolve) => {
      setConfirmDialog({
        title: opts.title,
        message: opts.message ?? '',
        confirmLabel: opts.confirmLabel ?? 'Confirm',
        cancelLabel: opts.cancelLabel ?? 'Cancel',
        danger: !!opts.danger,
        checkboxLabel: opts.checkboxLabel,
        checked: opts.checkboxDefault ?? false,
        resolve,
      })
    })

  const resolveConfirm = (confirmed: boolean) => {
    setConfirmDialog((d) => {
      d?.resolve({ confirmed, checked: d?.checked ?? false })
      return null
    })
  }

  const askPrompt = (opts: {
    title: string
    label?: string
    placeholder?: string
    defaultValue?: string
    confirmLabel?: string
  }): Promise<string | null> =>
    new Promise((resolve) => {
      setPromptDialog({
        title: opts.title,
        label: opts.label ?? '',
        placeholder: opts.placeholder ?? '',
        value: opts.defaultValue ?? '',
        confirmLabel: opts.confirmLabel ?? 'OK',
        resolve,
      })
    })

  const resolvePrompt = (value: string | null) => {
    setPromptDialog((d) => {
      d?.resolve(value)
      return null
    })
  }

  // Select every item (files and folders) in the current filtered view, across
  // pages. Acts as a toggle: if they're all already selected, clear them.
  const toggleSelectAll = () => {
    const allPaths = filteredItems.map(i => i.fullPath)
    if (allPaths.length === 0) return
    const allSelected = allPaths.every(p => selectedItems.has(p))
    setSelectedItems(allSelected ? new Set() : new Set(allPaths))
  }

  // True when every item in the current view is selected.
  const allFilteredSelected = filteredItems.length > 0 && filteredItems.every(i => selectedItems.has(i.fullPath))

  // Long-press to enter/extend selection on touch devices (no hover there to
  // reveal the checkbox). After a long press fires we set a flag so the click
  // that follows touchend doesn't also open/download the item.
  const longPressTimer = useRef<number | null>(null)
  const longPressFired = useRef(false)

  const startLongPress = (fullPath: string) => {
    longPressFired.current = false
    cancelLongPress()
    longPressTimer.current = window.setTimeout(() => {
      longPressFired.current = true
      toggleSelect(fullPath)
      if (typeof navigator !== 'undefined' && navigator.vibrate) navigator.vibrate(15)
    }, 450)
  }

  const cancelLongPress = () => {
    if (longPressTimer.current !== null) {
      clearTimeout(longPressTimer.current)
      longPressTimer.current = null
    }
  }

  const downloadSelectedItems = async () => {
    if (selectedItems.size === 0) return
    const paths = Array.from(selectedItems)
    const toDownload = items.filter(i => paths.includes(i.fullPath) && !i.isDir && !i.isDeleted)

    if (toDownload.length === 0) {
      clearSelection()
      return
    }

    // Try modern directory picker for choosing download location
    const hasDirectoryPicker = 'showDirectoryPicker' in window
    if (hasDirectoryPicker) {
      try {
        const dirHandle = await (window as any).showDirectoryPicker({ mode: 'readwrite' })
        let count = 0
        for (const item of toDownload) {
          try {
            const url = await getPresignedDownloadUrl(item)
            const res = await fetch(url)
            const blob = await res.blob()
            const fileHandle = await dirHandle.getFileHandle(item.name, { create: true })
            const writable = await fileHandle.createWritable()
            await writable.write(blob)
            await writable.close()
            count++
          } catch (e) {
            console.error('Failed to save', item.name, e)
          }
        }
        if (count > 0) {
          toast.success(`Downloaded ${count} file(s) to the selected folder`)
        }
        clearSelection()
        return
      } catch (err: any) {
        if (err.name === 'AbortError') {
          // user cancelled the picker
          return
        }
        console.log('Directory picker failed or not available in this context, falling back to default downloads')
      }
    }

    // Fallback: use normal download (browser default location)
    if (toDownload.length > 1 && !hasDirectoryPicker) {
      toast.info('Location picker not available in this browser/context. Files will go to your default Downloads folder.')
    }

    for (const item of toDownload) {
      await downloadFile(item)
      await new Promise(r => setTimeout(r, 150))
    }
    clearSelection()
  }

  // Permanently remove every version of a key (all data versions + delete
  // markers). This is the "force delete" — unlike a plain DeleteObject (which
  // just adds another delete marker) it purges the object entirely.
  const purgeAllVersions = async (key: string) => {
    if (!selectedBucket || !client) throw new Error('No bucket or client')
    let keyMarker: string | undefined
    let versionIdMarker: string | undefined
    let isTruncated = true
    while (isTruncated) {
      const resp: any = await client.send(
        new ListObjectVersionsCommand({
          Bucket: selectedBucket,
          Prefix: key,
          KeyMarker: keyMarker,
          VersionIdMarker: versionIdMarker,
        })
      )
      const versions = [...(resp.Versions || []), ...(resp.DeleteMarkers || [])]
        // Prefix is not an exact match (e.g. "a" matches "ab"), so filter to the exact key.
        .filter((v: any) => v.Key === key && v.VersionId)
      for (const v of versions) {
        await client.send(
          new DeleteObjectCommand({
            Bucket: selectedBucket,
            Key: key,
            VersionId: v.VersionId,
          })
        )
      }
      isTruncated = !!resp.IsTruncated
      keyMarker = resp.NextKeyMarker
      versionIdMarker = resp.NextVersionIdMarker
    }
  }

  // Server-side copy within the current bucket. CopySource wants
  // "<bucket>/<key>" with each path segment URL-encoded (keys can contain
  // spaces/unicode, but slashes must stay as separators).
  const copyObject = async (fromKey: string, toKey: string) => {
    if (!selectedBucket || !client) throw new Error('No bucket or client')
    const source = [selectedBucket, ...fromKey.split('/')].map(encodeURIComponent).join('/')
    await client.send(
      new CopyObjectCommand({ Bucket: selectedBucket, CopySource: source, Key: toKey })
    )
  }

  // True when an object with exactly this key exists. The key itself sorts
  // first among keys sharing it as a prefix, so MaxKeys=1 is enough.
  const keyExists = async (key: string): Promise<boolean> => {
    if (!selectedBucket || !client) return false
    const resp: any = await client.send(
      new ListObjectsV2Command({ Bucket: selectedBucket, Prefix: key, MaxKeys: 1 })
    )
    return (resp.Contents || []).some((o: any) => o.Key === key)
  }

  // A folder counts as "soft-deleted" once it has no live objects left under it
  // (everything is a delete marker). We detect that by asking for a single live
  // object: empty means the folder is in the soft-deleted state.
  const prefixHasLiveObjects = async (prefix: string): Promise<boolean> => {
    if (!selectedBucket || !client) return false
    const resp: any = await client.send(
      new ListObjectsV2Command({ Bucket: selectedBucket, Prefix: prefix, MaxKeys: 1 })
    )
    return (resp.Contents || []).length > 0
  }

  // Recursively delete everything under a folder prefix. force=false adds delete
  // markers to the current objects (soft, recoverable); force=true purges every
  // version + marker under the prefix (permanent).
  const deleteObjectsUnderPrefix = async (prefix: string, force: boolean) => {
    if (!selectedBucket || !client) throw new Error('No bucket or client')
    if (force) {
      let keyMarker: string | undefined
      let versionIdMarker: string | undefined
      let isTruncated = true
      while (isTruncated) {
        const resp: any = await client.send(
          new ListObjectVersionsCommand({ Bucket: selectedBucket, Prefix: prefix, KeyMarker: keyMarker, VersionIdMarker: versionIdMarker })
        )
        const versions = [...(resp.Versions || []), ...(resp.DeleteMarkers || [])].filter((v: any) => v.Key && v.VersionId)
        for (const v of versions) {
          await client.send(new DeleteObjectCommand({ Bucket: selectedBucket, Key: v.Key, VersionId: v.VersionId }))
        }
        isTruncated = !!resp.IsTruncated
        keyMarker = resp.NextKeyMarker
        versionIdMarker = resp.NextVersionIdMarker
      }
    } else {
      let continuationToken: string | undefined
      let isTruncated = true
      while (isTruncated) {
        const resp: any = await client.send(
          new ListObjectsV2Command({ Bucket: selectedBucket, Prefix: prefix, ContinuationToken: continuationToken })
        )
        for (const obj of (resp.Contents || [])) {
          if (obj.Key) await client.send(new DeleteObjectCommand({ Bucket: selectedBucket, Key: obj.Key }))
        }
        isTruncated = !!resp.IsTruncated
        continuationToken = resp.NextContinuationToken
      }
    }
  }

  const deleteSelectedItems = async () => {
    if (selectedItems.size === 0) return
    if (!selectedBucket || !client) {
      toast.error('No bucket or client')
      return
    }

    const paths = Array.from(selectedItems)
    const selected = items.filter(i => paths.includes(i.fullPath))
    if (selected.length === 0) {
      clearSelection()
      return
    }

    const files = selected.filter(i => !i.isDir)
    const folders = selected.filter(i => i.isDir)

    const lines: string[] = []
    const liveFiles = files.filter(i => !i.isDeleted)
    const deletedFiles = files.filter(i => i.isDeleted)
    if (liveFiles.length) lines.push(`• ${liveFiles.length} file(s) will be moved to deleted (recoverable).`)
    if (deletedFiles.length) lines.push(`• ${deletedFiles.length} already-deleted file(s) will be permanently removed.`)
    if (folders.length) lines.push(`• ${folders.length} folder(s) and all their contents.`)

    const { confirmed, checked: forceAll } = await askConfirm({
      title: `Delete ${selected.length} item(s)?`,
      message: lines.join('\n'),
      confirmLabel: 'Delete',
      danger: true,
      checkboxLabel: 'Force delete — permanently remove now (cannot be undone)',
    })
    if (!confirmed) return

    // With "Force delete" checked, everything is purged outright. Otherwise the
    // default two-pass behaviour: live -> soft delete, already-deleted -> purge;
    // folders are classified by whether they still hold live objects.
    let softFiles: FileItem[]
    let forceFiles: FileItem[]
    let softFolders: FileItem[]
    let forceFolders: FileItem[]
    if (forceAll) {
      softFiles = []
      forceFiles = files
      softFolders = []
      forceFolders = folders
    } else {
      softFiles = liveFiles
      forceFiles = deletedFiles
      const folderPlans = await Promise.all(
        folders.map(async (f) => ({ item: f, hasLive: await prefixHasLiveObjects(f.fullPath).catch(() => true) }))
      )
      softFolders = folderPlans.filter(p => p.hasLive).map(p => p.item)
      forceFolders = folderPlans.filter(p => !p.hasLive).map(p => p.item)
    }

    let okCount = 0
    let permanentCount = 0
    let errors = 0
    let done = 0
    const total = selected.length
    setCurrentDelete({ name: '', done: 0, total })

    const runEntry = async (item: FileItem, fn: () => Promise<any>, permanent: boolean) => {
      const label = item.isDir ? `${item.name}/` : item.name
      setCurrentDelete({ name: label, done, total })
      try {
        await fn()
        if (permanent) permanentCount++; else okCount++
      } catch (err: any) {
        console.error('Delete failed for', item.name, err)
        errors++
      }
      done++
      setCurrentDelete({ name: label, done, total })
    }

    for (const item of softFiles) {
      await runEntry(item, () => client.send(new DeleteObjectCommand({ Bucket: selectedBucket, Key: item.fullPath })), false)
    }
    for (const item of forceFiles) {
      await runEntry(item, () => purgeAllVersions(item.fullPath), true)
    }
    for (const item of softFolders) {
      await runEntry(item, () => deleteObjectsUnderPrefix(item.fullPath, false), false)
    }
    for (const item of forceFolders) {
      await runEntry(item, () => deleteObjectsUnderPrefix(item.fullPath, true), true)
    }

    if (okCount > 0) toast.success(`Deleted ${okCount} item(s)`)
    if (permanentCount > 0) toast.success(`Permanently deleted ${permanentCount} item(s)`)
    if (errors > 0) toast.error(`Failed to delete ${errors} item(s)`)
    clearSelection()
    setTimeout(() => setCurrentDelete(null), 650)
    loadObjects(selectedBucket, currentPrefix, client, creds, showDeleted)
  }

  const restoreSelectedItems = async () => {
    if (selectedItems.size === 0) return
    const paths = Array.from(selectedItems)
    const toRestore = items.filter(i => paths.includes(i.fullPath) && !i.isDir && i.isDeleted && i.versionId)

    if (toRestore.length === 0) {
      clearSelection()
      return
    }

    if (!(await askConfirm({ title: `Restore ${toRestore.length} item(s)?`, confirmLabel: 'Restore' })).confirmed) return

    if (!selectedBucket || !client) {
      toast.error('No bucket or client')
      return
    }

    let count = 0
    let errors = 0
    for (const item of toRestore) {
      try {
        await client.send(
          new DeleteObjectCommand({
            Bucket: selectedBucket,
            Key: item.fullPath,
            VersionId: item.versionId,
          })
        )
        count++
      } catch (err: any) {
        console.error('Restore failed for', item.name, err)
        errors++
      }
    }

    if (count > 0) {
      toast.success(`Restored ${count} item(s)`)
    }
    if (errors > 0) {
      toast.error(`Failed to restore ${errors} item(s)`)
    }
    clearSelection()
    loadObjects(selectedBucket, currentPrefix, client, creds, showDeleted)
  }

  const getPresignedDownloadUrl = async (item: FileItem): Promise<string> => {
    if (!selectedBucket || !client) throw new Error('No client')
    const command = new GetObjectCommand({
      Bucket: selectedBucket,
      Key: item.fullPath,
      ResponseContentDisposition: `attachment; filename="${item.name}"`,
    })
    return getSignedUrl(client, command, { expiresIn: 60 * 5 })
  }

  const generateShareableDownloadUrl = async (item: FileItem, expiresIn: number): Promise<string> => {
    if (!selectedBucket || !client) throw new Error('No client')
    const command = new GetObjectCommand({
      Bucket: selectedBucket,
      Key: item.fullPath,
      ResponseContentDisposition: `attachment; filename="${item.name}"`,
    })
    return getSignedUrl(client, command, { expiresIn })
  }

  const handleGenerateShareLink = async () => {
    if (!shareItem) return
    setIsGeneratingShare(true)
    try {
      const url = await generateShareableDownloadUrl(shareItem, shareExpirySeconds)
      setGeneratedShareUrl(url)
    } catch (err: any) {
      toast.error('Failed to generate link: ' + (err.message || 'Unknown error'))
    } finally {
      setIsGeneratingShare(false)
    }
  }

  const copyShareUrl = async () => {
    if (!generatedShareUrl) return
    try {
      await navigator.clipboard.writeText(generatedShareUrl)
      toast.success('Link copied to clipboard')
    } catch {
      toast.error('Failed to copy link')
    }
  }

  const openShareModal = (item: FileItem) => {
    setShareItem(item)
    setShareExpirySeconds(3600) // reset to 1h default
    setGeneratedShareUrl('')
    setShareModalOpen(true)
  }

  const closeShareModal = () => {
    setShareModalOpen(false)
    setShareItem(null)
    setGeneratedShareUrl('')
    setIsGeneratingShare(false)
  }

  const openNoteModal = async (item: FileItem) => {
    if (!selectedBucket || !client) return
    setNoteItem(item)
    setIsLoadingNote(true)
    setNoteModalOpen(true)
    try {
      const res = await client.send(new GetObjectTaggingCommand({
        Bucket: selectedBucket,
        Key: item.fullPath,
      }))
      const noteTag = res.TagSet?.find(t => t.Key === 'note')
      setNoteText(noteTag?.Value || '')
    } catch (err: any) {
      // No tags or error (e.g. no tagging permission or no tags set) - start empty
      setNoteText('')
    } finally {
      setIsLoadingNote(false)
    }
  }

  const closeNoteModal = () => {
    setNoteModalOpen(false)
    setNoteItem(null)
    setNoteText('')
    setIsLoadingNote(false)
    setIsSavingNote(false)
  }

  const saveNote = async () => {
    if (!noteItem || !selectedBucket || !client) return
    const text = noteText.trim()
    if (text.length > 256) {
      toast.error('Note cannot exceed 256 characters')
      return
    }
    setIsSavingNote(true)
    try {
      // Fetch existing tags to merge (so we don't overwrite other tags)
      let existingTags: { Key: string; Value: string }[] = []
      try {
        const res = await client.send(new GetObjectTaggingCommand({
          Bucket: selectedBucket,
          Key: noteItem.fullPath,
        }))
        existingTags = (res.TagSet || []).filter((t): t is { Key: string; Value: string } => !!t.Key) || []
      } catch {}

      // Remove any existing "note" tag
      const otherTags = existingTags.filter(t => t.Key !== 'note')

      const newTagSet = text
        ? [...otherTags, { Key: 'note', Value: text }]
        : otherTags

      await client.send(new PutObjectTaggingCommand({
        Bucket: selectedBucket,
        Key: noteItem.fullPath,
        Tagging: { TagSet: newTagSet }
      }))

      toast.success(text ? 'Note saved as tag' : 'Note removed')
      closeNoteModal()
    } catch (err: any) {
      toast.error('Failed to save note: ' + (err.message || 'Unknown error'))
    } finally {
      setIsSavingNote(false)
    }
  }

  const getRelativePosition = (e: React.MouseEvent) => {
    const rect = contentRef.current?.getBoundingClientRect()
    if (!rect) return { x: 0, y: 0 }
    return {
      x: e.clientX - rect.left,
      y: e.clientY - rect.top,
    }
  }

  const handleMouseDown = (e: React.MouseEvent) => {
    if (e.button !== 0) return
    const pos = getRelativePosition(e)
    setDragStartPos(pos)
    setDragCurrentPos(pos)
    setIsDragSelecting(true)
    // Prevent browser text selection during drag-select
    if (contentRef.current) {
      contentRef.current.style.userSelect = 'none'
    }
  }

  const handleMouseMove = (e: React.MouseEvent) => {
    if (!isDragSelecting) return
    const pos = getRelativePosition(e)
    setDragCurrentPos(pos)
  }

  const handleMouseUp = () => {
    if (!isDragSelecting) return
    setIsDragSelecting(false)

    // Re-enable text selection
    if (contentRef.current) {
      contentRef.current.style.userSelect = ''
    }

    const start = dragStartPos
    const end = dragCurrentPos
    const left = Math.min(start.x, end.x)
    const top = Math.min(start.y, end.y)
    const right = Math.max(start.x, end.x)
    const bottom = Math.max(start.y, end.y)

    if (Math.abs(right - left) < 8 && Math.abs(bottom - top) < 8) {
      return
    }

    const container = contentRef.current
    if (!container) return

    const cards = container.querySelectorAll('[data-fullpath]') as NodeListOf<HTMLElement>
    const next = new Set(selectedItems)

    cards.forEach((card) => {
      const fullPath = card.dataset.fullpath
      if (!fullPath || card.dataset.isdir === 'true') return
      const cRect = card.getBoundingClientRect()
      const cLeft = cRect.left - container.getBoundingClientRect().left
      const cTop = cRect.top - container.getBoundingClientRect().top
      const cRight = cLeft + cRect.width
      const cBottom = cTop + cRect.height
      if (cLeft < right && cRight > left && cTop < bottom && cBottom > top) {
        next.add(fullPath)
      }
    })

    setSelectedItems(next)
  }

  // --- Folder upload helpers ---
  async function getFileFromEntry(fileEntry: any): Promise<File> {
    return new Promise((resolve, reject) => {
      fileEntry.file(resolve, reject)
    })
  }

  async function readDirectoryEntries(dirReader: any): Promise<any[]> {
    return new Promise((resolve) => {
      dirReader.readEntries((entries: any[]) => resolve(entries))
    })
  }

  async function getAllEntries(dirEntry: any): Promise<any[]> {
    const reader = dirEntry.createReader()
    let entries: any[] = []
    let batch: any[]
    do {
      batch = await readDirectoryEntries(reader)
      entries = entries.concat(batch)
    } while (batch.length > 0)
    return entries
  }

  async function processEntry(entry: any, results: { file: File; relativePath: string }[]) {
    if (entry.isFile) {
      const file = await getFileFromEntry(entry)
      let path = entry.fullPath || entry.name
      if (path.startsWith('/')) path = path.substring(1)
      results.push({ file, relativePath: path })
    } else if (entry.isDirectory) {
      const children = await getAllEntries(entry)
      for (const child of children) {
        await processEntry(child, results)
      }
    }
  }

  function getStorageKey(relativePath: string): string {
    const parts = relativePath.split('/').filter(Boolean)
    if (parts.length === 0) return ''
    const fileName = parts.pop()!
    const dir = parts.length > 0 ? parts.join('/') + '/' : ''
    const mangled = makeStorageName(fileName)
    return dir + mangled
  }

  const uploadFilesWithStructure = async (
    entries: { file: File; relativePath: string }[]
  ) => {
    if (!selectedBucket || !client) {
      toast.error('Select a bucket first')
      return
    }

    const total = entries.length
    let done = 0

    for (const { file, relativePath } of entries) {
      const objectName = currentPrefix + getStorageKey(relativePath)
      const displayName = relativePath.split('/').pop() || relativePath

      // Show the bar immediately so it always appears, even before the first
      // progress event (and even for tiny files that finish in one chunk).
      setCurrentUpload({ name: displayName, percent: 0, speed: 0, done, total })

      try {
        const upload = new Upload({
          client,
          params: {
            Bucket: selectedBucket,
            Key: objectName,
            Body: file,
            ContentType: file.type || 'application/octet-stream',
          },
        })

        let lastLoaded = 0
        let lastTime = Date.now()
        let lastSpeed = 0

        upload.on('httpUploadProgress', (progress: any) => {
          const totalBytes = progress.total || file.size
          if (!totalBytes) return
          const percent = Math.round((progress.loaded / totalBytes) * 100)
          const now = Date.now()
          const timeDiff = (now - lastTime) / 1000
          if (timeDiff > 0.25) {
            const bytesDiff = progress.loaded - lastLoaded
            lastSpeed = bytesDiff / timeDiff / (1024 * 1024)
            lastLoaded = progress.loaded
            lastTime = now
          }
          setCurrentUpload({
            name: displayName,
            percent,
            speed: parseFloat(Math.max(0, lastSpeed).toFixed(1)),
            done,
            total,
          })
        })

        await upload.done()

        done++
        setCurrentUpload({
          name: displayName,
          percent: 100,
          speed: 0,
          done,
          total,
        })
        toast.success(`Uploaded ${displayName}`)
      } catch (err: any) {
        console.error(err)
        toast.error(`Upload failed: ${displayName}`)
      }
    }

    setTimeout(() => {
      setCurrentUpload(null)
      if (selectedBucket && client && creds) {
        loadObjects(selectedBucket, currentPrefix, client, creds, showDeleted)
      }
    }, 650)
  }

  const uploadFiles = async (files: FileList | File[]) => {
    const fileArray = Array.from(files)
    if (fileArray.length === 0) return

    const entries = fileArray.map((f) => ({
      file: f,
      relativePath: (f as any).webkitRelativePath || f.name,
    }))

    await uploadFilesWithStructure(entries)
  }

  const handleFolderUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
      const fileArray = Array.from(e.target.files)
      const entries = fileArray.map((f) => ({
        file: f,
        relativePath: (f as any).webkitRelativePath || f.name,
      }))
      uploadFilesWithStructure(entries).then(() => {
        e.target.value = ''
      })
    }
  }
  // --- end folder helpers ---

  const createFolder = async () => {
    if (!selectedBucket || !client) return

    const folderName = await askPrompt({
      title: 'New folder',
      label: 'Folder name',
      placeholder: 'e.g. vacation-2024',
      confirmLabel: 'Create',
    })
    if (!folderName || !folderName.trim()) return

    const name = folderName.trim()
    if (name.includes('/')) {
      toast.error('Folder name cannot contain /')
      return
    }

    const key = `${currentPrefix}${name}/`

    try {
      await client.send(
        new PutObjectCommand({
          Bucket: selectedBucket,
          Key: key,
          Body: '',
        })
      )
      toast.success(`Created folder "${name}"`)
      loadObjects(selectedBucket, currentPrefix, client, creds, showDeleted)
    } catch (err: any) {
      toast.error('Failed to create folder: ' + (err.message || ''))
    }
  }

  const downloadFile = async (item: FileItem) => {
    if (!selectedBucket || !client) return

    try {
      const url = await getPresignedDownloadUrl(item)
      const res = await fetch(url)
      const blob = await res.blob()

      // Try modern save location picker (only works on HTTPS or localhost in Chromium browsers)
      const canUseFilePicker = 'showSaveFilePicker' in window
      if (canUseFilePicker) {
        try {
          const fileHandle = await (window as any).showSaveFilePicker({
            suggestedName: item.name,
          })
          const writable = await fileHandle.createWritable()
          await writable.write(blob)
          await writable.close()
          return
        } catch (pickerErr: any) {
          if (pickerErr.name === 'AbortError') {
            return // user cancelled
          }
          // API not available in this context (e.g. accessed via IP over HTTP) → fall through
        }
      }

      // Standard browser download (goes to default Downloads folder, no location prompt)
      const a = document.createElement('a')
      a.href = URL.createObjectURL(blob)
      a.download = item.name
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      URL.revokeObjectURL(a.href)

      // Optional one-time hint if picker was not available
      if (!canUseFilePicker && !sessionStorage.getItem('downloadHintShown')) {
        sessionStorage.setItem('downloadHintShown', 'true')
        toast.info('Downloads go to your browser\'s default folder. For a save dialog, access via localhost or HTTPS.')
      }
    } catch (err: any) {
      toast.error('Download failed: ' + err.message)
    }
  }

  const deleteFile = async (item: FileItem) => {
    if (!selectedBucket || !client || !creds) return

    // Already-deleted items are always purged. Live items soft-delete by default,
    // unless the user ticks "Force delete" to remove them permanently now.
    const alreadyDeleted = !!item.isDeleted
    const { confirmed, checked } = await askConfirm({
      title: alreadyDeleted ? `Permanently delete ${item.name}?` : `Delete ${item.name}?`,
      message: alreadyDeleted
        ? 'All versions will be removed and this cannot be undone.'
        : 'This item will be moved to deleted (recoverable).',
      confirmLabel: alreadyDeleted ? 'Delete forever' : 'Delete',
      danger: true,
      checkboxLabel: alreadyDeleted ? undefined : 'Force delete — permanently remove now (cannot be undone)',
    })
    if (!confirmed) return
    const force = alreadyDeleted || checked

    try {
      if (force) {
        await purgeAllVersions(item.fullPath)
        toast.success(`Permanently deleted ${item.name}`)
      } else {
        await client.send(
          new DeleteObjectCommand({
            Bucket: selectedBucket,
            Key: item.fullPath,
          })
        )
        toast.success(`Deleted ${item.name}`)
      }
      loadObjects(selectedBucket, currentPrefix, client, creds, showDeleted)
    } catch (err: any) {
      toast.error('Delete failed: ' + err.message)
    }
  }

  // S3 has no rename: copy to the new key, then soft-delete the old one (the
  // original stays recoverable under its old name in the deleted view).
  const renameFile = async (item: FileItem) => {
    if (!selectedBucket || !client || item.isDir || item.isBucket || item.isDeleted) return

    const input = await askPrompt({
      title: `Rename ${item.name}`,
      label: 'New name',
      defaultValue: item.name,
      confirmLabel: 'Rename',
    })
    if (input === null) return
    const newName = input.trim()
    if (!newName || newName === item.name) return
    if (newName.includes('/')) {
      toast.error('Name cannot contain /')
      return
    }

    const slashIdx = item.fullPath.lastIndexOf('/')
    const dir = slashIdx >= 0 ? item.fullPath.slice(0, slashIdx + 1) : ''
    const baseName = item.fullPath.slice(dir.length)
    // Keep the original upload-time stamp so the key stays unique and the
    // listing keeps its chronological order; only the display name changes.
    const stamp = baseName.match(/^\d{13,}-/)?.[0] ?? ''
    const newKey = dir + stamp + newName
    if (newKey === item.fullPath) return

    try {
      // Unstamped keys aren't guaranteed unique, so guard against overwriting.
      if (!stamp && (await keyExists(newKey))) {
        toast.error(`"${newName}" already exists`)
        return
      }
      await copyObject(item.fullPath, newKey)
      await client.send(new DeleteObjectCommand({ Bucket: selectedBucket, Key: item.fullPath }))
      toast.success(`Renamed to ${newName}`)
      loadObjects(selectedBucket, currentPrefix, client, creds, showDeleted)
    } catch (err: any) {
      toast.error('Rename failed: ' + (err.message || ''))
    }
  }

  // Folders are just key prefixes, so renaming one means copying every object
  // under the old prefix to the new one, then purging the originals (all
  // versions — see below). All copies happen before any delete: a mid-way
  // failure can leave duplicates, never data loss.
  const renameFolder = async (item: FileItem) => {
    if (!selectedBucket || !client || !item.isDir || item.isBucket) return

    const input = await askPrompt({
      title: `Rename ${item.name}`,
      label: 'New name',
      defaultValue: item.name,
      confirmLabel: 'Rename',
    })
    if (input === null) return
    const newName = input.trim()
    if (!newName || newName === item.name) return
    if (newName.includes('/')) {
      toast.error('Folder name cannot contain /')
      return
    }

    const oldPrefix = item.fullPath // always ends in '/'
    const newPrefix = oldPrefix.slice(0, oldPrefix.length - item.name.length - 1) + newName + '/'

    try {
      const existing: any = await client.send(
        new ListObjectsV2Command({ Bucket: selectedBucket, Prefix: newPrefix, MaxKeys: 1 })
      )
      if ((existing.Contents || []).length > 0) {
        toast.error(`A folder named "${newName}" already exists`)
        return
      }

      const keys: string[] = []
      let continuationToken: string | undefined
      let isTruncated = true
      while (isTruncated) {
        const page: any = await client.send(
          new ListObjectsV2Command({ Bucket: selectedBucket, Prefix: oldPrefix, ContinuationToken: continuationToken })
        )
        for (const obj of (page.Contents || [])) {
          if (obj.Key) keys.push(obj.Key)
        }
        isTruncated = !!page.IsTruncated
        continuationToken = page.NextContinuationToken
      }
      if (keys.length === 0) {
        toast.error('Folder is empty or no longer exists')
        loadObjects(selectedBucket, currentPrefix, client, creds, showDeleted)
        return
      }

      const label = `${item.name}/ → ${newName}/`
      // Each key is one copy + one delete.
      const total = keys.length * 2
      let done = 0
      setCurrentRename({ name: label, done, total })

      try {
        for (const key of keys) {
          await copyObject(key, newPrefix + key.slice(oldPrefix.length))
          done++
          setCurrentRename({ name: label, done, total })
        }
      } catch (err: any) {
        toast.error(`Rename failed while copying (nothing was deleted): ${err.message || ''}`)
        return
      }

      // Purge every version + delete marker under the old prefix. A soft
      // delete is not enough here: MinIO keeps listing a prefix that holds
      // only delete markers, so the old folder would linger as a ghost.
      let deleteErrors = 0
      const seenKeys = new Set<string>()
      let keyMarker: string | undefined
      let versionIdMarker: string | undefined
      let truncated = true
      while (truncated) {
        const page: any = await client.send(
          new ListObjectVersionsCommand({ Bucket: selectedBucket, Prefix: oldPrefix, KeyMarker: keyMarker, VersionIdMarker: versionIdMarker })
        )
        const versions = [...(page.Versions || []), ...(page.DeleteMarkers || [])].filter((v: any) => v.Key && v.VersionId)
        for (const v of versions) {
          try {
            await client.send(new DeleteObjectCommand({ Bucket: selectedBucket, Key: v.Key, VersionId: v.VersionId }))
          } catch {
            deleteErrors++
          }
          // Progress counts keys, not versions — a key may have many versions.
          if (!seenKeys.has(v.Key)) {
            seenKeys.add(v.Key)
            done++
            setCurrentRename({ name: label, done: Math.min(done, total), total })
          }
        }
        truncated = !!page.IsTruncated
        keyMarker = page.NextKeyMarker
        versionIdMarker = page.NextVersionIdMarker
      }
      setCurrentRename({ name: label, done: total, total })

      if (deleteErrors > 0) {
        toast.error(`Renamed, but ${deleteErrors} old version(s) could not be removed from "${item.name}"`)
      } else {
        toast.success(`Renamed folder to ${newName}`)
      }
      loadObjects(selectedBucket, currentPrefix, client, creds, showDeleted)
    } catch (err: any) {
      toast.error('Rename failed: ' + (err.message || ''))
    } finally {
      setTimeout(() => setCurrentRename(null), 650)
    }
  }

  const restoreFile = async (item: FileItem) => {
    if (!selectedBucket || !client) return
    if (!item.versionId) {
      toast.error('Cannot restore: missing version info')
      return
    }
    if (!(await askConfirm({ title: `Restore ${item.name}?`, confirmLabel: 'Restore' })).confirmed) return

    try {
      await client.send(
        new DeleteObjectCommand({
          Bucket: selectedBucket,
          Key: item.fullPath,
          VersionId: item.versionId,
        })
      )
      toast.success(`Restored ${item.name}`)
      loadObjects(selectedBucket, currentPrefix, client, creds, showDeleted)
    } catch (err: any) {
      toast.error('Restore failed: ' + err.message)
    }
  }

  const openPreview = async (item: FileItem) => {
    if (!selectedBucket || !client) return
    setPreviewItem(item)

    try {
      const command = new GetObjectCommand({
        Bucket: selectedBucket,
        Key: item.fullPath,
      })
      const url = await getSignedUrl(client, command, { expiresIn: 300 })
      setPreviewUrl(url)
    } catch (e) {
      toast.error('Failed to generate preview link')
      closePreview()
    }
  }

  const closePreview = () => {
    setPreviewItem(null)
    setPreviewUrl(null)
  }

  // Navigate prev/next within the current folder's images (respects current filter/search)
  const goPrevImage = useCallback(() => {
    if (!previewItem || currentImages.length === 0) return
    const idx = currentImages.findIndex(i => i.fullPath === previewItem.fullPath)
    if (idx > 0) {
      openPreview(currentImages[idx - 1])
    }
  }, [previewItem, currentImages])

  const goNextImage = useCallback(() => {
    if (!previewItem || currentImages.length === 0) return
    const idx = currentImages.findIndex(i => i.fullPath === previewItem.fullPath)
    if (idx >= 0 && idx < currentImages.length - 1) {
      openPreview(currentImages[idx + 1])
    }
  }, [previewItem, currentImages])

  const handleDrop = async (e: React.DragEvent) => {
    e.preventDefault()

    // IMPORTANT: DataTransfer items/files are only valid during the synchronous
    // part of the drop event — the browser clears the list as soon as we yield
    // (the first await). So grab every entry (and snapshot the plain file list)
    // up front; the FileSystemEntry objects stay valid afterwards. Reading
    // items[i] after an await is what previously dropped all but the first file.
    const itemList = e.dataTransfer.items
    const entries: any[] = []
    if (itemList && itemList.length > 0) {
      for (let i = 0; i < itemList.length; i++) {
        const entry = itemList[i].webkitGetAsEntry?.()
        if (entry) entries.push(entry)
      }
    }
    const plainFiles = Array.from(e.dataTransfer.files || [])

    if (entries.length > 0) {
      const results: { file: File; relativePath: string }[] = []
      for (const entry of entries) {
        await processEntry(entry, results)
      }
      if (results.length > 0) {
        await uploadFilesWithStructure(results)
        return
      }
    }

    // Fallback for plain files (entries API unavailable)
    if (plainFiles.length > 0) {
      await uploadFiles(plainFiles)
    }
  }

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault()
  }

  const handleLoginSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    connect(loginForm)
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (promptDialog) { resolvePrompt(null); return }
        if (confirmDialog) { resolveConfirm(false); return }
        if (previewItem) closePreview()
        if (shareModalOpen) closeShareModal()
      } else if (previewItem) {
        if (e.key === 'ArrowLeft') {
          e.preventDefault()
          goPrevImage()
        }
        if (e.key === 'ArrowRight') {
          e.preventDefault()
          goNextImage()
        }
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [previewItem, shareModalOpen, goPrevImage, goNextImage, confirmDialog, promptDialog])

  // LOGIN SCREEN
  if (!isLoggedIn) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-warm-50 p-6">
        <div className="w-full max-w-md">
          <div className="mb-8 text-center">
            <div className="inline-flex items-center justify-center w-14 h-14 rounded-2xl bg-beige-200 mb-4">
              <Folder className="text-beige-700" size={28} />
            </div>
            <h1 className="text-3xl font-semibold tracking-tight text-warm-900">MinStorage</h1>
          </div>

          <div className="card p-8">
            <form onSubmit={handleLoginSubmit} className="space-y-5">
              <div>
                <label className="block text-sm font-medium mb-1.5 text-warm-900">User</label>
                <input
                  type="text"
                  className="input"
                  placeholder="minioadmin"
                  value={loginForm.accessKey}
                  onChange={(e) => setLoginForm({ ...loginForm, accessKey: e.target.value })}
                />
              </div>
              <div>
                <label className="block text-sm font-medium mb-1.5 text-warm-900">Password</label>
                <div className="relative">
                  <input
                    type={showPassword ? 'text' : 'password'}
                    className="input pr-10"
                    placeholder="minioadmin"
                    value={loginForm.secretKey}
                    onChange={(e) => setLoginForm({ ...loginForm, secretKey: e.target.value })}
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword((v) => !v)}
                    className="absolute inset-y-0 right-0 flex items-center pr-3 text-beige-700 hover:text-warm-900"
                    aria-label={showPassword ? 'Hide password' : 'Show password'}
                  >
                    {showPassword ? <EyeOff size={18} /> : <Eye size={18} />}
                  </button>
                </div>
              </div>

              <button type="submit" className="btn btn-primary w-full mt-2 justify-center">
                Connect to MinIO
              </button>
            </form>
          </div>
        </div>
      </div>
    )
  }

  // MAIN UI (logged in)
  return (
    <div className="flex flex-col min-h-screen bg-warm-50">
      {/* Header */}
      <header className="relative border-b border-line/70 bg-surface/70 backdrop-blur-xl sticky top-0 z-50">
        {/* Navbar — action buttons on the left (full toolbar on desktop; phone & tablet use the burger) */}
        <div className="px-3 sm:px-4 lg:px-6 h-16 flex items-center gap-2 sm:gap-3 lg:gap-4 overflow-visible">
          <div className="hidden lg:flex items-center gap-1.5 overflow-x-auto whitespace-nowrap">
            {isInSelectMode && (
              <div className="flex items-center gap-1.5 pr-1.5 mr-0.5 border-r border-beige-200">
                <span className="px-2 py-0.5 bg-blue-100 text-blue-700 dark:bg-blue-500/25 dark:text-blue-200 rounded-md text-xs font-medium">
                  {selectedItems.size}
                </span>
                <button onClick={toggleSelectAll} className="btn btn-secondary text-sm py-1.5 px-3">
                  {allFilteredSelected ? 'Deselect all' : 'Select all'}
                </button>
                <button onClick={downloadSelectedItems} className="btn btn-primary text-sm py-1.5 px-3">
                  Download
                </button>
                <button onClick={restoreSelectedItems} className="btn btn-secondary text-sm py-1.5 px-3 text-green-600 hover:bg-green-50">
                  Restore
                </button>
                <button
                  onClick={deleteSelectedItems}
                  className={`btn text-sm py-1.5 px-3 ${selectedDeleteIsForce ? 'btn-primary bg-red-600 border-red-600 hover:bg-red-700 hover:border-red-700' : 'btn-secondary text-red-600 hover:bg-red-50'}`}
                  title={selectedDeleteIsForce ? 'Permanently remove the selected deleted items (all versions)' : 'Move selected items to deleted (recoverable)'}
                >
                  {selectedDeleteIsForce ? 'Delete forever' : 'Delete'}
                </button>
                <button onClick={clearSelection} className="btn btn-secondary text-sm py-1.5 px-3">
                  Clear
                </button>
              </div>
            )}

            {/* Switch between personal and shared bucket */}
            {(() => {
              const onShared = selectedBucket === 'shared'
              if (onShared && homeBucket) {
                return (
                  <button onClick={() => selectBucket(homeBucket)} className="btn btn-secondary text-sm py-1.5 px-3 flex items-center gap-1.5" title="Go to your files">
                    <Folder size={15} /> <span>My files</span>
                  </button>
                )
              }
              if (!onShared && buckets.includes('shared')) {
                return (
                  <button onClick={() => selectBucket('shared')} className="btn btn-secondary text-sm py-1.5 px-3 flex items-center gap-1.5" title="Go to shared files">
                    <Users size={15} /> <span>Shared</span>
                  </button>
                )
              }
              return null
            })()}

            {selectedBucket && (
              <button onClick={createFolder} className="btn btn-secondary text-sm py-1.5 px-3 flex items-center gap-1.5">
                <FolderPlus size={15} /> <span>Create folder</span>
              </button>
            )}

            {selectedBucket && (
              <label className="btn btn-primary cursor-pointer text-sm py-1.5 px-3 flex items-center gap-1.5">
                <UploadIcon size={15} />
                <span>Upload files</span>
                <input
                  type="file"
                  multiple
                  className="hidden"
                  onChange={(e) => {
                    if (e.target.files) uploadFiles(e.target.files)
                    e.target.value = ''
                  }}
                />
              </label>
            )}

            {selectedBucket && (
              <label className="btn btn-secondary cursor-pointer text-sm py-1.5 px-3 flex items-center gap-1.5">
                <FolderUp size={15} />
                <span>Upload folder</span>
                <input
                  type="file"
                  // @ts-ignore - webkit specific
                  webkitdirectory=""
                  directory=""
                  multiple
                  className="hidden"
                  onChange={handleFolderUpload}
                />
              </label>
            )}

            <button onClick={disconnect} className="btn btn-secondary text-sm py-1.5 px-3 flex items-center gap-1.5 text-red-600" title="Disconnect">
              <LogOut size={15} />
              <span>Disconnect</span>
            </button>
          </div>

          {/* Theme toggle (always visible, far right) */}
          <button
            onClick={toggleTheme}
            className="btn-icon ml-auto shrink-0"
            aria-label={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
            title={theme === 'dark' ? 'Light mode' : 'Dark mode'}
          >
            {theme === 'dark' ? <Sun size={18} /> : <Moon size={18} />}
          </button>

          {/* Burger menu button (phone + tablet) */}
          <button
            onClick={() => setMobileMenuOpen(!mobileMenuOpen)}
            className="btn-icon lg:hidden shrink-0 -mr-1"
            aria-label="Toggle menu"
            aria-expanded={mobileMenuOpen}
          >
            <Menu size={22} />
          </button>
        </div>

        {/* Burger menu (phone + tablet): floating panel */}
        {mobileMenuOpen && (
          <>
            <div className="lg:hidden fixed inset-0 z-40" onClick={() => setMobileMenuOpen(false)} />
            <div className="lg:hidden absolute right-3 top-full mt-2 z-50 w-[17rem] max-w-[calc(100vw-1.5rem)] menu-panel p-2 text-sm">
              {isInSelectMode && (
                <div className="flex flex-col gap-2 p-2 mb-1 border-b border-line">
                  <span className="self-start px-2.5 py-1 bg-blue-100 text-blue-700 dark:bg-blue-500/25 dark:text-blue-200 rounded-full text-xs font-medium">
                    {selectedItems.size} selected
                  </span>
                  <button onClick={toggleSelectAll} className="btn btn-secondary text-sm py-2 justify-center w-full">
                    {allFilteredSelected ? 'Deselect all' : 'Select all'}
                  </button>
                  <div className="grid grid-cols-2 gap-1.5">
                    <button onClick={() => { downloadSelectedItems(); setMobileMenuOpen(false); }} className="btn btn-primary text-sm py-2 justify-center">Download</button>
                    <button onClick={() => { restoreSelectedItems(); setMobileMenuOpen(false); }} className="btn btn-secondary text-sm py-2 justify-center text-green-600">Restore</button>
                    <button onClick={() => { deleteSelectedItems(); setMobileMenuOpen(false); }} className={`btn text-sm py-2 justify-center ${selectedDeleteIsForce ? 'btn-primary bg-red-600 text-white' : 'btn-secondary text-red-600'}`}>{selectedDeleteIsForce ? 'Delete forever' : 'Delete'}</button>
                    <button onClick={() => { clearSelection(); setMobileMenuOpen(false); }} className="btn btn-secondary text-sm py-2 justify-center">Clear</button>
                  </div>
                </div>
              )}

              {(() => {
                const onShared = selectedBucket === 'shared'
                if (onShared && homeBucket) {
                  return (
                    <button onClick={() => { selectBucket(homeBucket); setMobileMenuOpen(false); }} className="menu-item">
                      <Folder size={17} /> My files
                    </button>
                  )
                }
                if (!onShared && buckets.includes('shared')) {
                  return (
                    <button onClick={() => { selectBucket('shared'); setMobileMenuOpen(false); }} className="menu-item">
                      <Users size={17} /> Shared
                    </button>
                  )
                }
                return null
              })()}

              {selectedBucket && (
                <button onClick={() => { createFolder(); setMobileMenuOpen(false); }} className="menu-item">
                  <FolderPlus size={17} /> Create folder
                </button>
              )}

              {selectedBucket && (
                <label className="menu-item cursor-pointer">
                  <UploadIcon size={17} /> Upload files
                  {/* @ts-ignore */}
                  <input type="file" multiple className="hidden" onChange={(e) => { if (e.target.files) { uploadFiles(e.target.files); setMobileMenuOpen(false); } e.target.value = ''; }} />
                </label>
              )}

              {selectedBucket && (
                <label className="menu-item cursor-pointer">
                  <FolderUp size={17} /> Upload folder
                  {/* @ts-ignore */}
                  <input type="file" webkitdirectory="" directory="" multiple className="hidden" onChange={(e) => { handleFolderUpload(e); setMobileMenuOpen(false); }} />
                </label>
              )}

              <div className="my-1 border-t border-line" />

              <button onClick={() => { disconnect(); setMobileMenuOpen(false); }} className="menu-item text-red-600">
                <LogOut size={17} /> Disconnect
              </button>
            </div>
          </>
        )}
      </header>

      <div className="flex flex-1 w-full overflow-hidden">
        {/* Main */}
        <div className="flex-1 flex flex-col min-w-0 min-h-0">
          <div
            ref={contentRef}
            className={`flex-1 p-3 sm:p-6 overflow-auto relative ${isDragSelecting ? 'select-none' : ''}`}
            onDrop={handleDrop}
            onDragOver={handleDragOver}
            onMouseDown={handleMouseDown}
            onMouseMove={handleMouseMove}
            onMouseUp={handleMouseUp}
            onMouseLeave={handleMouseUp}
          >
            {!selectedBucket && buckets.length === 0 ? (
              <div className="h-[60vh] flex items-center justify-center text-center">
                <div>
                  <div className="text-beige-500 mb-2"><Folder size={48} className="mx-auto" /></div>
                  <div className="text-lg font-medium">No buckets available</div>
                </div>
              </div>
            ) : (
              <>
                {currentUpload && (
                  <div className="mb-5 card p-4">
                    <div className="text-xs uppercase tracking-widest mb-1 text-beige-600 font-semibold">Uploading</div>
                    <div className="flex justify-between text-xs mb-1 text-beige-600">
                      <span>{currentUpload.done}/{currentUpload.total} files</span>
                      <span>{currentUpload.speed > 0 ? `${currentUpload.speed} MB/s` : ''}</span>
                    </div>
                    <div className="h-2 bg-beige-200 rounded overflow-hidden mb-1">
                      <div 
                        className="h-full bg-beige-500 transition-all" 
                        style={{ width: `${currentUpload.percent}%` }} 
                      />
                    </div>
                    <div className="text-sm truncate font-medium mt-1">{currentUpload.name}</div>
                  </div>
                )}

                {currentDelete && (
                  <div className="mb-5 card p-4">
                    <div className="text-xs uppercase tracking-widest mb-1 text-red-600 font-semibold">Deleting</div>
                    <div className="flex justify-between text-xs mb-1 text-beige-600">
                      <span>{currentDelete.done}/{currentDelete.total} items</span>
                    </div>
                    <div className="h-2 bg-beige-200 rounded overflow-hidden mb-1">
                      <div
                        className="h-full bg-red-500 transition-all"
                        style={{ width: `${currentDelete.total > 0 ? Math.round((currentDelete.done / currentDelete.total) * 100) : 0}%` }}
                      />
                    </div>
                    {currentDelete.name && <div className="text-sm truncate font-medium mt-1">{currentDelete.name}</div>}
                  </div>
                )}

                {currentRename && (
                  <div className="mb-5 card p-4">
                    <div className="text-xs uppercase tracking-widest mb-1 text-blue-600 font-semibold">Renaming</div>
                    <div className="flex justify-between text-xs mb-1 text-beige-600">
                      <span>{currentRename.done}/{currentRename.total} operations</span>
                    </div>
                    <div className="h-2 bg-beige-200 rounded overflow-hidden mb-1">
                      <div
                        className="h-full bg-blue-500 transition-all"
                        style={{ width: `${currentRename.total > 0 ? Math.round((currentRename.done / currentRename.total) * 100) : 0}%` }}
                      />
                    </div>
                    {currentRename.name && <div className="text-sm truncate font-medium mt-1">{currentRename.name}</div>}
                  </div>
                )}

                {/* Breadcrumb path (above the search toolbar). With more than two
                    buckets, "root" is the home crumb and lists buckets as folders;
                    otherwise the bucket name is the home crumb. */}
                <div className="mb-3 flex items-center gap-1 min-w-0 overflow-x-auto whitespace-nowrap text-xs sm:text-sm">
                  {rootEnabled && (
                    <button
                      onClick={goToRoot}
                      className={`font-medium shrink-0 ${selectedBucket ? 'text-muted hover:text-fg' : 'text-fg hover:text-accent'}`}
                      title="All buckets"
                    >
                      root
                    </button>
                  )}
                  {selectedBucket && (
                    <span className="flex items-center gap-1 min-w-0">
                      {rootEnabled && <ChevronRight size={12} className="text-muted shrink-0" />}
                      <button
                        onClick={goHome}
                        className={`font-medium hover:text-accent shrink-0 truncate max-w-[10rem] ${rootEnabled ? 'text-muted hover:text-fg' : 'text-fg'}`}
                        title="Go to bucket root"
                      >
                        {selectedBucket === 'shared' ? 'Shared' : selectedBucket}
                      </button>
                    </span>
                  )}
                  {breadcrumbs.map((crumb, idx) => (
                    <span key={idx} className="flex items-center gap-0.5 text-muted shrink-0">
                      <ChevronRight size={12} />
                      <button onClick={() => navigateTo(crumb.prefix)} className="hover:text-fg text-muted truncate max-w-[5rem] sm:max-w-[8rem]">
                        {crumb.label}
                      </button>
                    </span>
                  ))}
                </div>

                {/* Content toolbar: search + type (left) + per-page + showing/pagination (right) */}
                {!loading && (
                  <div className="mb-3 flex flex-wrap items-center gap-2 text-xs sm:text-sm text-beige-700 overflow-x-hidden">
                    {/* Left: search bar + search type dropdown (grows but capped) */}
                    <div className="flex flex-1 items-center gap-2 min-w-[120px] sm:min-w-[220px] max-w-md">
                      <div className="relative flex-1 min-w-[100px]">
                        <Search size={15} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-muted pointer-events-none" />
                        <input
                          type="text"
                          value={search}
                          onChange={(e) => setSearch(e.target.value)}
                          placeholder="Search..."
                          className="input w-full pl-9 text-sm"
                        />
                      </div>
                      <select
                        value={searchType}
                        onChange={(e) => setSearchType(e.target.value as 'name' | 'note')}
                        className="select"
                      >
                        <option value="name">Name</option>
                        <option value="note">Note</option>
                      </select>
                    </div>

                    {/* Controls: per-page + page nav (mobile friendly) */}
                    <div className="flex items-center gap-1.5 sm:gap-2 shrink-0">
                      <select
                        value={pageSize}
                        onChange={(e) => {
                          const v = e.target.value
                          const newSize = v === 'all' ? 'all' : (parseInt(v, 10) as 100 | 200 | 400)
                          setPageSize(newSize)
                          setCurrentPage(1)
                        }}
                        className="select tabular-nums"
                        title="Items per page"
                      >
                        <option value={100}>100</option>
                        <option value={200}>200</option>
                        <option value={400}>400</option>
                        <option value="all">All</option>
                      </select>

                      {/* View toggle: grid / list */}
                      <div className="segmented shrink-0">
                        <button
                          onClick={() => setViewMode('grid')}
                          data-active={viewMode === 'grid'}
                          className="seg-btn"
                          title="Grid view (preview)"
                        >
                          <LayoutGrid size={15} />
                        </button>
                        <button
                          onClick={() => setViewMode('list')}
                          data-active={viewMode === 'list'}
                          className="seg-btn"
                          title="List view"
                        >
                          <List size={15} />
                        </button>
                      </div>

                      {/* Show deleted / show notes toggles (icon-only, like the view toggle) */}
                      <button
                        onClick={() => setShowDeleted(!showDeleted)}
                        aria-pressed={showDeleted}
                        title={showDeleted ? 'Hide deleted' : 'Show deleted (incl. delete markers)'}
                        className={`shrink-0 inline-flex items-center justify-center w-9 h-9 rounded-full transition-colors ${showDeleted ? 'bg-surface3 text-fg' : 'text-muted hover:text-fg hover:bg-surface2'}`}
                      >
                        {showDeleted ? <EyeOff size={16} /> : <Eye size={16} />}
                      </button>
                      <button
                        onClick={() => setShowNotes(!showNotes)}
                        aria-pressed={showNotes}
                        title={showNotes ? 'Hide notes' : 'Show notes'}
                        className={`shrink-0 inline-flex items-center justify-center w-9 h-9 rounded-full transition-colors ${showNotes ? 'bg-surface3 text-fg' : 'text-muted hover:text-fg hover:bg-surface2'}`}
                      >
                        <MessageSquare size={16} />
                      </button>

                      {totalPages > 1 && (
                        <div className="flex items-center gap-0.5 sm:gap-1">
                          <span className="tabular-nums text-beige-600 text-[10px] sm:text-xs whitespace-nowrap">
                            Page {currentPage} / {totalPages}
                          </span>

                          <div className="flex items-center gap-0.5">
                            <button
                              onClick={() => setCurrentPage(1)}
                              disabled={currentPage === 1}
                              className="btn btn-secondary text-[10px] py-0.5 px-1 hidden sm:inline disabled:opacity-50"
                            >
                              First
                            </button>
                            <button
                              onClick={() => setCurrentPage((p) => Math.max(1, p - 1))}
                              disabled={currentPage === 1}
                              className="btn btn-secondary text-[10px] py-0.5 px-1 flex items-center gap-0.5 disabled:opacity-50"
                            >
                              <ChevronLeft size={12} /> <span className="hidden sm:inline">Prev</span>
                            </button>
                            <button
                              onClick={() => setCurrentPage((p) => Math.min(totalPages, p + 1))}
                              disabled={currentPage === totalPages}
                              className="btn btn-secondary text-[10px] py-0.5 px-1 flex items-center gap-0.5 disabled:opacity-50"
                            >
                              <span className="hidden sm:inline">Next</span> <ChevronRight size={12} />
                            </button>
                            <button
                              onClick={() => setCurrentPage(totalPages)}
                              disabled={currentPage === totalPages}
                              className="btn btn-secondary text-[10px] py-0.5 px-1 hidden sm:inline disabled:opacity-50"
                            >
                              Last
                            </button>
                          </div>
                        </div>
                      )}
                    </div>

                    {/* Showing text pushed to the far right */}
                    {filteredItems.length > 0 && (
                      <span className="ml-auto tabular-nums text-beige-600 whitespace-nowrap">
                        {pageSize === 'all'
                          ? `Showing all ${filteredItems.length}`
                          : (() => {
                              const ps = pageSize
                              const start = Math.min((currentPage - 1) * ps + 1, filteredItems.length)
                              const end = Math.min(currentPage * ps, filteredItems.length)
                              return `Showing ${start}–${end} of ${filteredItems.length}`
                            })()}
                      </span>
                    )}
                  </div>
                )}

                {loading ? (
                  viewMode === 'grid' ? (
                    <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 2xl:grid-cols-7 gap-4">
                      {Array.from({ length: 8 }).map((_, i) => (
                        <div key={i} className="card h-44 animate-pulse bg-beige-100" />
                      ))}
                    </div>
                  ) : (
                    <div className="border border-beige-200 rounded-xl bg-surface overflow-hidden">
                      {Array.from({ length: 6 }).map((_, i) => (
                        <div key={i} className="h-9 bg-beige-100 animate-pulse border-b border-beige-200 last:border-b-0" />
                      ))}
                    </div>
                  )
                ) : filteredItems.length === 0 ? (
                  <div className="text-center py-8 sm:py-16 text-beige-700">
                    {search ? 'No matching files' : 'This folder is empty'}
                  </div>
                ) : viewMode === 'grid' ? (
                  <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 2xl:grid-cols-7 gap-3 sm:gap-4 items-start">
                    {visibleItems.map((item, index) => (
                      <div
                        key={index}
                        className={`file-item card flex flex-col group relative overflow-visible ${item.isDeleted ? 'opacity-60' : ''} ${selectedItems.has(item.fullPath) ? 'ring-2 ring-blue-400' : ''}`}
                        data-fullpath={item.fullPath}
                        data-isdir={item.isDir ? 'true' : 'false'}
                        onMouseEnter={(e) => {
                          if (!showNotes && !item.isDir && notes[item.fullPath]) {
                            setTooltip({ text: notes[item.fullPath], x: e.clientX, y: e.clientY });
                          }
                        }}
                        onMouseMove={(e) => {
                          if (!showNotes && !item.isDir && notes[item.fullPath]) {
                            setTooltip({ text: notes[item.fullPath], x: e.clientX, y: e.clientY });
                          }
                        }}
                        onMouseLeave={() => setTooltip(null)}
                      >
                        {item.isDir ? (
                          <>
                            {/* Select checkbox — hidden unless selected/in select mode or hovered.
                                Buckets (root view) aren't selectable. */}
                            {!item.isBucket && (
                              <div
                                className={`absolute top-2 left-2 z-30 transition-opacity ${isInSelectMode ? 'opacity-100' : 'opacity-0 pointer-events-none group-hover:opacity-100 group-hover:pointer-events-auto'}`}
                                onClick={(e) => { e.stopPropagation(); toggleSelect(item.fullPath) }}
                              >
                                <div
                                  className={`w-4 h-4 rounded border flex items-center justify-center transition-colors ${
                                    selectedItems.has(item.fullPath)
                                      ? 'bg-blue-500 border-blue-500'
                                      : 'bg-surface/80 border-gray-300 hover:border-blue-400'
                                  }`}
                                >
                                  {selectedItems.has(item.fullPath) && <Check size={10} className="text-white" />}
                                </div>
                              </div>
                            )}
                            {/* Folder actions - always on mobile, hover on desktop. Buckets can't be renamed. */}
                            {!item.isBucket && (
                              <div className="absolute top-2 right-2 flex gap-1.5 opacity-100 sm:opacity-0 sm:group-hover:opacity-100 transition-all z-30">
                                <button
                                  onClick={(e) => { e.stopPropagation(); renameFolder(item); }}
                                  className="bg-surface/90 hover:bg-surface text-beige-700 p-1.5 rounded-lg shadow-sm hover:shadow transition-colors"
                                  title="Rename folder"
                                >
                                  <Pencil size={15} />
                                </button>
                              </div>
                            )}
                            <button
                              onClick={() => {
                                if (longPressFired.current) { longPressFired.current = false; return }
                                if (item.isBucket) { selectBucket(item.fullPath) }
                                else if (isInSelectMode) { toggleSelect(item.fullPath) }
                                else { navigateTo(item.fullPath) }
                              }}
                              onTouchStart={() => { if (!item.isBucket) startLongPress(item.fullPath) }}
                              onTouchEnd={cancelLongPress}
                              onTouchMove={cancelLongPress}
                              onTouchCancel={cancelLongPress}
                              className="flex-1 p-2 sm:p-3 flex flex-col select-none [-webkit-touch-callout:none]"
                            >
                              <div className="thumbnail w-full h-32 sm:h-40 flex items-center justify-center bg-beige-100 group-hover:bg-beige-200 transition-colors">
                                {item.isBucket ? (
                                  <>
                                    <Database size={36} className="sm:hidden text-beige-600" />
                                    <Database size={46} className="hidden sm:block text-beige-600" />
                                  </>
                                ) : (
                                  <>
                                    <Folder size={36} className="sm:hidden text-beige-600" />
                                    <Folder size={46} className="hidden sm:block text-beige-600" />
                                  </>
                                )}
                              </div>
                              <div className="pt-3 px-1">
                                <div className="font-medium text-sm truncate">{item.name}</div>
                                <div className="text-xs text-beige-600">{item.isBucket ? 'Bucket' : 'Folder'}</div>
                              </div>
                            </button>
                          </>
                        ) : (
                          <>
                            <div className="relative overflow-hidden">
                              <div
                                className="cursor-pointer select-none [-webkit-touch-callout:none]"
                                onTouchStart={() => startLongPress(item.fullPath)}
                                onTouchEnd={cancelLongPress}
                                onTouchMove={cancelLongPress}
                                onTouchCancel={cancelLongPress}
                                onClick={() => {
                                  if (longPressFired.current) { longPressFired.current = false; return }
                                  if (isInSelectMode) {
                                    toggleSelect(item.fullPath)
                                  } else if (!item.isDeleted) {
                                    isImage(item.name) ? openPreview(item) : downloadFile(item)
                                  }
                                }}
                              >
                                {/* Select icon top-left — hidden unless selected/in select mode or hovered */}
                                <div
                                  className={`absolute top-2 left-2 z-30 transition-opacity ${isInSelectMode ? 'opacity-100' : 'opacity-0 pointer-events-none group-hover:opacity-100 group-hover:pointer-events-auto'}`}
                                  onClick={(e) => {
                                    e.stopPropagation()
                                    toggleSelect(item.fullPath)
                                  }}
                                >
                                  <div
                                    className={`w-4 h-4 rounded border flex items-center justify-center transition-colors ${
                                      selectedItems.has(item.fullPath)
                                        ? 'bg-blue-500 border-blue-500'
                                        : 'bg-surface/80 border-gray-300 hover:border-blue-400'
                                    }`}
                                  >
                                    {selectedItems.has(item.fullPath) && <Check size={10} className="text-white" />}
                                  </div>
                                </div>

                                {item.isDeleted ? (
                                  <div className="thumbnail w-full h-32 sm:h-40 bg-red-50 flex items-center justify-center">
                                    <Trash2 size={32} className="sm:hidden text-red-400" />
                                    <Trash2 size={42} className="hidden sm:block text-red-400" />
                                  </div>
                                ) : isImage(item.name) && creds && selectedBucket ? (
                                  <ObjectThumbnail
                                    bucket={selectedBucket}
                                    objectName={item.fullPath}
                                    creds={creds}
                                  />
                                ) : (
                                  <div className="thumbnail w-full h-32 sm:h-40 bg-beige-50">
                                    <File size={32} className="sm:hidden text-beige-500" />
                                    <File size={42} className="hidden sm:block text-beige-500" />
                                  </div>
                                )}
                              </div>

                              {/* Action buttons - always on mobile, hover on desktop */}
                              <div className="absolute top-2 right-2 flex gap-1.5 opacity-100 sm:opacity-0 sm:group-hover:opacity-100 transition-all z-10">
                                {item.isDeleted ? (
                                  <button
                                    onClick={(e) => { e.stopPropagation(); restoreFile(item); }}
                                    className="bg-surface/90 hover:bg-green-50 text-green-600 p-1.5 rounded-lg shadow-sm hover:shadow transition-colors"
                                    title="Restore"
                                  >
                                    <RotateCcw size={15} />
                                  </button>
                                ) : (
                                  <>
                                    <button
                                      onClick={(e) => { e.stopPropagation(); downloadFile(item); }}
                                      className="bg-surface/90 hover:bg-surface text-beige-700 p-1.5 rounded-lg shadow-sm hover:shadow transition-colors"
                                      title="Download"
                                    >
                                      <Download size={15} />
                                    </button>
                                    <button
                                      onClick={(e) => { e.stopPropagation(); openShareModal(item); }}
                                      className="bg-surface/90 hover:bg-surface text-beige-700 p-1.5 rounded-lg shadow-sm hover:shadow transition-colors"
                                      title="Get shareable download link"
                                    >
                                      <Link size={15} />
                                    </button>
                                    <button
                                      onClick={(e) => { e.stopPropagation(); openNoteModal(item); }}
                                      className="bg-surface/90 hover:bg-surface text-beige-700 p-1.5 rounded-lg shadow-sm hover:shadow transition-colors"
                                      title="Add/Edit note"
                                    >
                                      <MessageSquare size={15} />
                                    </button>
                                    <button
                                      onClick={(e) => { e.stopPropagation(); renameFile(item); }}
                                      className="bg-surface/90 hover:bg-surface text-beige-700 p-1.5 rounded-lg shadow-sm hover:shadow transition-colors"
                                      title="Rename"
                                    >
                                      <Pencil size={15} />
                                    </button>
                                  </>
                                )}
                                <button
                                  onClick={(e) => { e.stopPropagation(); deleteFile(item); }}
                                  className="bg-surface/90 hover:bg-red-50 text-red-600 p-1.5 rounded-lg shadow-sm hover:shadow transition-colors"
                                  title={item.isDeleted ? "Permanently delete" : "Delete"}
                                >
                                  <Trash2 size={15} />
                                </button>
                              </div>
                            </div>

                            {/* Compact bottom info: only name + date + size */}
                            <div className="p-2 sm:p-2.5">
                              <div
                                onClick={() => {
                                  if (isInSelectMode) {
                                    toggleSelect(item.fullPath)
                                  } else if (!item.isDeleted) {
                                    isImage(item.name) ? openPreview(item) : downloadFile(item)
                                  }
                                }}
                                className={`font-medium text-sm leading-tight truncate cursor-pointer hover:underline mb-1 ${item.isDeleted ? 'line-through text-red-400' : ''}`}
                              >
                                {item.name}
                                {item.isDeleted && <span className="ml-1 text-[9px] text-red-400">(deleted)</span>}
                              </div>

                              <div className="flex items-center justify-between text-[10px] text-beige-600">
                                <span>{formatSize(item.size)}</span>
                                {item.lastModified && <span>{format(item.lastModified, 'MMM d')}</span>}
                              </div>

                              {showNotes && notes[item.fullPath] && (
                                <div className="mt-1 text-sm text-fg break-words" title={notes[item.fullPath]}>
                                  {notes[item.fullPath]}
                                </div>
                              )}
                            </div>
                          </>
                        )}
                      </div>
                    ))}
                  </div>
                ) : (
                  /* Minimal list view - no image previews at all */
                  <div className="divide-y divide-beige-200 border border-beige-200 rounded-xl bg-surface overflow-hidden">
                    {visibleItems.map((item, index) => {
                      const isSelected = selectedItems.has(item.fullPath)
                      return (
                        <div
                          key={index}
                          className={`flex items-center gap-2 sm:gap-3 px-2 sm:px-3 py-1 sm:py-1.5 group text-sm hover:bg-beige-50 transition-colors select-none [-webkit-touch-callout:none] ${item.isDeleted ? 'opacity-60' : ''} ${isSelected ? 'bg-blue-50/40' : ''}`}
                          data-fullpath={item.fullPath}
                          data-isdir={item.isDir ? 'true' : 'false'}
                          onTouchStart={() => { if (!item.isBucket) startLongPress(item.fullPath) }}
                          onTouchEnd={cancelLongPress}
                          onTouchMove={cancelLongPress}
                          onTouchCancel={cancelLongPress}
                          onMouseEnter={(e) => {
                            if (!showNotes && !item.isDir && notes[item.fullPath]) {
                              setTooltip({ text: notes[item.fullPath], x: e.clientX, y: e.clientY })
                            }
                          }}
                          onMouseMove={(e) => {
                            if (!showNotes && !item.isDir && notes[item.fullPath]) {
                              setTooltip({ text: notes[item.fullPath], x: e.clientX, y: e.clientY })
                            }
                          }}
                          onMouseLeave={() => setTooltip(null)}
                        >
                          {/* Select checkbox — hidden unless selected/in select mode or hovered.
                              Buckets (root view) aren't selectable. */}
                          {item.isBucket ? (
                            <div className="w-4 h-4 shrink-0" />
                          ) : (
                            <div
                              className={`w-4 h-4 rounded border flex items-center justify-center shrink-0 cursor-pointer transition-all ${isSelected ? 'bg-blue-500 border-blue-500' : 'bg-surface border-gray-300 hover:border-blue-400'} ${isInSelectMode ? 'opacity-100' : 'opacity-0 pointer-events-none group-hover:opacity-100 group-hover:pointer-events-auto'}`}
                              onClick={(e) => { e.stopPropagation(); toggleSelect(item.fullPath) }}
                            >
                              {isSelected && <Check size={10} className="text-white" />}
                            </div>
                          )}

                          {/* Icon (no preview) */}
                          <div className="shrink-0 text-beige-600">
                            {item.isBucket ? <Database size={16} /> : item.isDir ? <Folder size={16} /> : <File size={16} />}
                          </div>

                          {/* Name */}
                          <div
                            className={`flex-1 min-w-0 truncate font-medium cursor-pointer hover:underline ${item.isDeleted ? 'line-through text-red-400' : 'text-warm-900'}`}
                            onClick={() => {
                              if (longPressFired.current) { longPressFired.current = false; return }
                              if (item.isBucket) {
                                selectBucket(item.fullPath)
                              } else if (isInSelectMode) {
                                toggleSelect(item.fullPath)
                              } else if (item.isDir) {
                                navigateTo(item.fullPath)
                              } else if (!item.isDeleted) {
                                isImage(item.name) ? openPreview(item) : downloadFile(item)
                              }
                            }}
                          >
                            {item.name}
                            {item.isDeleted && <span className="ml-1 text-[9px] text-red-400">(deleted)</span>}
                          </div>

                          {/* Note (inline if shown) */}
                          {showNotes && !item.isDir && notes[item.fullPath] && (
                            <div className="max-w-[120px] sm:max-w-[180px] truncate text-xs text-fg" title={notes[item.fullPath]}>
                              {notes[item.fullPath]}
                            </div>
                          )}

                          {/* Size */}
                          <div className="hidden sm:block w-16 text-right text-[11px] text-beige-600 shrink-0 tabular-nums">
                            {item.isDir ? '—' : formatSize(item.size)}
                          </div>

                          {/* Date */}
                          <div className="hidden sm:block w-[70px] text-right text-[11px] text-beige-600 shrink-0">
                            {item.lastModified ? format(item.lastModified, 'MMM d') : '—'}
                          </div>

                          {/* Minimal actions (always on mobile, hover on desktop) */}
                          {!item.isDir ? (
                            <div className="flex gap-0.5 opacity-100 sm:opacity-0 sm:group-hover:opacity-100 transition shrink-0">
                              {item.isDeleted ? (
                                <button onClick={(e) => { e.stopPropagation(); restoreFile(item) }} className="p-1 rounded hover:bg-green-100 text-green-600" title="Restore">
                                  <RotateCcw size={14} />
                                </button>
                              ) : (
                                <>
                                  <button onClick={(e) => { e.stopPropagation(); downloadFile(item) }} className="p-1 rounded hover:bg-beige-100 text-beige-700" title="Download">
                                    <Download size={14} />
                                  </button>
                                  <button onClick={(e) => { e.stopPropagation(); openShareModal(item) }} className="p-1 rounded hover:bg-beige-100 text-beige-700" title="Share">
                                    <Link size={14} />
                                  </button>
                                  <button onClick={(e) => { e.stopPropagation(); openNoteModal(item) }} className="p-1 rounded hover:bg-beige-100 text-beige-700" title="Note">
                                    <MessageSquare size={14} />
                                  </button>
                                  <button onClick={(e) => { e.stopPropagation(); renameFile(item) }} className="p-1 rounded hover:bg-beige-100 text-beige-700" title="Rename">
                                    <Pencil size={14} />
                                  </button>
                                </>
                              )}
                              <button onClick={(e) => { e.stopPropagation(); deleteFile(item) }} className="p-1 rounded hover:bg-red-100 text-red-600" title="Delete">
                                <Trash2 size={14} />
                              </button>
                            </div>
                          ) : !item.isBucket ? (
                            <div className="flex gap-0.5 opacity-100 sm:opacity-0 sm:group-hover:opacity-100 transition shrink-0">
                              <button onClick={(e) => { e.stopPropagation(); renameFolder(item) }} className="p-1 rounded hover:bg-beige-100 text-beige-700" title="Rename">
                                <Pencil size={14} />
                              </button>
                            </div>
                          ) : (
                            <div className="w-8" />
                          )}
                        </div>
                      )
                    })}
                  </div>
                )}

                {/* Drag selection overlay */}
                {isDragSelecting && (
                  <div
                    className="absolute border-2 border-blue-500 bg-blue-500/20 pointer-events-none z-50"
                    style={{
                      left: Math.min(dragStartPos.x, dragCurrentPos.x),
                      top: Math.min(dragStartPos.y, dragCurrentPos.y),
                      width: Math.abs(dragStartPos.x - dragCurrentPos.x),
                      height: Math.abs(dragStartPos.y - dragCurrentPos.y),
                    }}
                  />
                )}
              </>
            )}
          </div>
        </div>
      </div>


      {/* Preview Modal */}
      {previewItem && previewUrl && (
        <div className="modal" onClick={closePreview}>
          <div className="modal-content !w-[90vw] !h-[90vh] !max-w-none !max-h-none" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between px-5 py-3 border-b border-beige-200 bg-beige-50">
              <div className="font-medium truncate pr-4 max-w-[45%]">{previewItem.name}</div>
              <div className="flex items-center gap-2">
                <div className="flex items-center gap-0.5 mr-1">
                  <button
                    onClick={goPrevImage}
                    disabled={previewIndex <= 0}
                    className="btn btn-ghost p-1.5 disabled:opacity-40"
                    title="Previous image"
                  >
                    <ChevronLeft size={16} />
                  </button>
                  {previewTotal > 1 && (
                    <span className="text-[10px] text-beige-600 px-1 tabular-nums select-none">
                      {previewIndex + 1} / {previewTotal}
                    </span>
                  )}
                  <button
                    onClick={goNextImage}
                    disabled={previewIndex < 0 || previewIndex >= previewTotal - 1}
                    className="btn btn-ghost p-1.5 disabled:opacity-40"
                    title="Next image"
                  >
                    <ChevronRight size={16} />
                  </button>
                </div>
                <button onClick={() => downloadFile(previewItem)} className="btn btn-secondary text-xs sm:text-sm">
                  <Download size={14} /> <span className="hidden sm:inline">Download</span>
                </button>
                <button onClick={closePreview} className="btn btn-ghost p-2">
                  <X size={18} />
                </button>
              </div>
            </div>
            <div className="p-5 bg-beige-100 flex items-center justify-center flex-1 min-h-0 overflow-hidden">
              <img
                src={previewUrl}
                alt={previewItem.name}
                className="max-w-full max-h-full object-contain rounded-lg shadow-sm bg-surface"
              />
            </div>
            <div className="px-5 py-2.5 text-xs border-t border-beige-200 bg-surface text-beige-600 flex justify-between">
              <div>{formatSize(previewItem.size)}</div>
              {previewItem.lastModified && <div>{format(previewItem.lastModified, 'PPpp')}</div>}
            </div>
          </div>
        </div>
      )}

      {/* Share Link Modal */}
      {shareModalOpen && shareItem && (
        <div className="modal" onClick={closeShareModal}>
          <div className="modal-content w-full max-w-[500px] mx-auto" onClick={e => e.stopPropagation()}>
            {/* Header */}
            <div className="flex items-center justify-between px-5 py-3 border-b border-beige-200 bg-beige-50">
              <div className="font-medium">Share download link</div>
              <button onClick={closeShareModal} className="btn btn-ghost p-2">
                <X size={18} />
              </button>
            </div>

            <div className="p-5 space-y-4">
              {/* File info */}
              <div>
                <div className="text-xs uppercase tracking-widest text-beige-600 mb-1">File</div>
                <div className="font-medium truncate bg-beige-50 px-3 py-2 rounded text-sm border border-beige-100">
                  {shareItem.name}
                </div>
              </div>

              {/* Expiry options */}
              <div>
                <div className="text-xs uppercase tracking-widest text-beige-600 mb-2">Link expires after</div>

                {/* Presets */}
                <div className="flex flex-wrap gap-2 mb-2">
                  {[900, 3600, 21600, 86400, 604800].map((secs) => {
                    const labels: Record<number, string> = {
                      900: '15 min',
                      3600: '1 hour',
                      21600: '6 hours',
                      86400: '24 hours',
                      604800: '7 days',
                    }
                    const active = shareExpirySeconds === secs
                    return (
                      <button
                        key={secs}
                        onClick={() => {
                          setShareExpirySeconds(secs)
                          setGeneratedShareUrl('')
                        }}
                        className={`btn text-xs py-1 px-3 ${active ? 'btn-primary' : 'btn-secondary'}`}
                      >
                        {labels[secs]}
                      </button>
                    )
                  })}
                </div>

                {/* Custom minutes */}
                <div className="flex items-center gap-2">
                  <input
                    type="number"
                    min={1}
                    max={10080}
                    value={Math.floor(shareExpirySeconds / 60)}
                    onChange={(e) => {
                      const mins = Math.max(1, parseInt(e.target.value) || 1)
                      setShareExpirySeconds(mins * 60)
                      setGeneratedShareUrl('')
                    }}
                    className="input w-20 py-1 text-sm"
                    onFocus={() => {
                      // When user focuses custom, keep current value but mark as custom
                    }}
                  />
                  <span className="text-sm text-beige-600">minutes (custom)</span>
                </div>

                <div className="text-[10px] text-beige-500 mt-1.5">
                  Longer links are less secure. 7 days is the recommended maximum.
                </div>
              </div>

              {/* Action area */}
              {!generatedShareUrl ? (
                <button
                  onClick={handleGenerateShareLink}
                  disabled={isGeneratingShare}
                  className="btn btn-primary w-full justify-center"
                >
                  {isGeneratingShare ? 'Generating link...' : 'Generate shareable link'}
                </button>
              ) : (
                <div className="space-y-3">
                  <div>
                    <div className="text-xs uppercase tracking-widest text-beige-600 mb-1.5">Share this link</div>
                    <div className="flex gap-2">
                      <input
                        type="text"
                        value={generatedShareUrl}
                        readOnly
                        className="input flex-1 text-xs font-mono bg-beige-50"
                        onClick={(e) => (e.target as HTMLInputElement).select()}
                      />
                      <button 
                        onClick={copyShareUrl} 
                        className="btn btn-secondary text-xs px-3 flex items-center gap-1"
                      >
                        <Check size={14} /> Copy
                      </button>
                    </div>
                  </div>

                  <div className="text-xs text-beige-500">
                    This link will stop working in <span className="font-medium">{Math.floor(shareExpirySeconds / 60)} minutes</span>.
                  </div>

                  <button
                    onClick={() => setGeneratedShareUrl('')}
                    className="btn btn-secondary w-full text-xs justify-center"
                  >
                    Generate a new link
                  </button>
                </div>
              )}

              <div className="pt-2 text-[10px] text-beige-500 border-t border-beige-100">
                Anyone with this link can download the file. No login required.
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Note Modal */}
      {noteModalOpen && noteItem && (
        <div className="modal" onClick={closeNoteModal}>
          <div className="modal-content w-full max-w-md" onClick={e => e.stopPropagation()}>
            {/* Header */}
            <div className="flex items-center justify-between px-5 py-3 border-b border-beige-200 bg-beige-50">
              <div className="font-medium truncate pr-4">Note for {noteItem.name}</div>
              <button onClick={closeNoteModal} className="btn btn-ghost p-2">
                <X size={18} />
              </button>
            </div>

            <div className="p-5">
              {isLoadingNote ? (
                <div className="text-center py-8 text-beige-600">Loading note...</div>
              ) : (
                <>
                  <textarea
                    value={noteText}
                    onChange={(e) => setNoteText(e.target.value)}
                    maxLength={256}
                    placeholder="Enter your note here..."
                    className="input h-32 w-full resize-y text-sm"
                    disabled={isSavingNote}
                  />
                  <div className="text-xs text-beige-500 text-right mt-1">
                    {noteText.length}/256
                  </div>

                  <div className="flex gap-2 mt-4">
                    <button
                      onClick={closeNoteModal}
                      disabled={isSavingNote}
                      className="btn btn-secondary flex-1"
                    >
                      Cancel
                    </button>
                    <button
                      onClick={saveNote}
                      disabled={isSavingNote}
                      className="btn btn-primary flex-1"
                    >
                      {isSavingNote ? 'Saving...' : 'Save note'}
                    </button>
                  </div>

                  {noteText.length > 0 && (
                    <button
                      onClick={() => setNoteText('')}
                      disabled={isSavingNote}
                      className="btn btn-ghost w-full mt-2 text-xs text-red-600"
                    >
                      Clear note
                    </button>
                  )}
                </>
              )}
            </div>

            <div className="px-5 py-3 text-[10px] text-beige-500 border-t border-beige-100 bg-beige-50">
              This note is stored as a tag (key: "note") on the object.
            </div>
          </div>
        </div>
      )}

      {/* Confirm dialog */}
      {confirmDialog && (
        <div className="modal" onClick={() => resolveConfirm(false)}>
          <div className="modal-content w-full max-w-sm mx-auto" onClick={e => e.stopPropagation()}>
            <div className="px-5 py-3 border-b border-beige-200 bg-beige-50 font-medium">
              {confirmDialog.title}
            </div>
            {confirmDialog.message && (
              <div className="px-5 pt-5 text-sm text-warm-800 whitespace-pre-line">{confirmDialog.message}</div>
            )}
            {confirmDialog.checkboxLabel && (
              <label className="flex items-start gap-2.5 px-5 pt-4 text-sm cursor-pointer select-none text-warm-900">
                <input
                  type="checkbox"
                  checked={confirmDialog.checked}
                  onChange={(e) => setConfirmDialog((d) => (d ? { ...d, checked: e.target.checked } : d))}
                  className="mt-0.5 h-4 w-4 shrink-0 accent-red-600 cursor-pointer"
                />
                <span>{confirmDialog.checkboxLabel}</span>
              </label>
            )}
            <div className="flex gap-2 px-5 pb-5 pt-5">
              <button onClick={() => resolveConfirm(false)} className="btn btn-secondary flex-1">
                {confirmDialog.cancelLabel}
              </button>
              <button
                autoFocus
                onClick={() => resolveConfirm(true)}
                className={`btn flex-1 ${confirmDialog.danger ? 'btn-primary bg-red-600 border-red-600 hover:bg-red-700 hover:border-red-700' : 'btn-primary'}`}
              >
                {confirmDialog.confirmLabel}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Prompt dialog */}
      {promptDialog && (
        <div className="modal" onClick={() => resolvePrompt(null)}>
          <form
            className="modal-content w-full max-w-sm mx-auto"
            onClick={e => e.stopPropagation()}
            onSubmit={(e) => { e.preventDefault(); resolvePrompt(promptDialog.value) }}
          >
            <div className="px-5 py-3 border-b border-beige-200 bg-beige-50 font-medium">
              {promptDialog.title}
            </div>
            <div className="p-5">
              {promptDialog.label && (
                <label className="block text-sm font-medium mb-1.5 text-warm-900">{promptDialog.label}</label>
              )}
              <input
                autoFocus
                type="text"
                className="input w-full"
                placeholder={promptDialog.placeholder}
                value={promptDialog.value}
                onChange={(e) => setPromptDialog(d => d ? { ...d, value: e.target.value } : d)}
              />
              <div className="flex gap-2 mt-4">
                <button type="button" onClick={() => resolvePrompt(null)} className="btn btn-secondary flex-1">
                  Cancel
                </button>
                <button type="submit" className="btn btn-primary flex-1">
                  {promptDialog.confirmLabel}
                </button>
              </div>
            </div>
          </form>
        </div>
      )}

      {/* Cursor-following tooltip for notes */}
      {tooltip && !showNotes && (
        <div 
          className="fixed z-[100] pointer-events-none bg-beige-50 border border-beige-200 text-fg text-sm px-3 py-2 rounded-lg shadow-md max-w-[280px] whitespace-pre-wrap break-words"
          style={{ 
            left: `${tooltip.x + 12}px`, 
            top: `${tooltip.y + 12}px` 
          }}
        >
          {tooltip.text}
        </div>
      )}
    </div>
  )
}

export default App
