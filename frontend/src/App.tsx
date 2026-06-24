import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  S3Client,
  ListBucketsCommand,
  ListObjectsV2Command,
  ListObjectVersionsCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  GetObjectTaggingCommand,
  PutObjectTaggingCommand,
} from '@aws-sdk/client-s3'
import { Upload } from '@aws-sdk/lib-storage'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import {
  Upload as UploadIcon, Download, Trash2, Folder, File, Image as ImageIcon, RefreshCw,
  LogOut, ChevronRight, Home, X, Check, Eye, EyeOff, RotateCcw, Link, FolderPlus, MessageSquare,
  LayoutGrid, List
} from 'lucide-react'
import { format } from 'date-fns'
import { toast } from 'sonner'
import { v4 as uuidv4 } from 'uuid'
import './App.css'

// Types
interface Credentials {
  endpoint: string
  accessKey: string
  secretKey: string
  useSSL: boolean
  previewUrl: string
}

interface FileItem {
  name: string
  fullPath: string
  size: number
  lastModified?: Date
  isDir: boolean
  isDeleted?: boolean
  versionId?: string
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
  const protocol = creds.useSSL ? 'https' : 'http'
  const endpoint = `${protocol}://${creds.endpoint}`

  return new S3Client({
    endpoint,
    region: 'us-east-1',
    credentials: {
      accessKeyId: creds.accessKey,
      secretAccessKey: creds.secretKey,
    },
    forcePathStyle: true,
  })
}

async function listObjectsWithPrefix(
  client: S3Client,
  bucket: string,
  prefix: string,
  showDeleted: boolean = false
): Promise<{ files: any[]; prefixes: string[] }> {
  if (!showDeleted) {
    const command = new ListObjectsV2Command({
      Bucket: bucket,
      Prefix: prefix,
      Delimiter: '/',
    })

    const response = await client.send(command)

    let prefixes = (response.CommonPrefixes || [])
      .map((p) => p.Prefix!)
      .filter(Boolean)

    prefixes = prefixes.filter(p => p && p !== prefix && p.startsWith(prefix || ''))

    const files = (response.Contents || [])
      .filter((obj) => obj.Key && obj.Key !== prefix)
      .map((obj) => ({
        name: obj.Key!,
        size: obj.Size || 0,
        etag: obj.ETag || '',
        lastModified: obj.LastModified,
        isDeleted: false,
      }))

    return { files, prefixes }
  }

  // Show deleted: use versions + delete markers
  const command = new ListObjectVersionsCommand({
    Bucket: bucket,
    Prefix: prefix,
    Delimiter: '/',
  })

  const response = await client.send(command)

  let prefixes = (response.CommonPrefixes || [])
    .map((p) => p.Prefix!)
    .filter(Boolean)

  prefixes = prefixes.filter(p => p && p !== prefix && p.startsWith(prefix || ''))

  const files: any[] = []

  // Add current versions (non-deleted latest objects)
  ;(response.Versions || []).forEach((obj: any) => {
    if (obj.Key && obj.Key !== prefix && obj.IsLatest) {
      files.push({
        name: obj.Key!,
        size: obj.Size || 0,
        etag: obj.ETag || '',
        lastModified: obj.LastModified,
        isDeleted: false,
      })
    }
  })

  // Add delete markers as deleted items
  ;(response.DeleteMarkers || []).forEach((dm: any) => {
    if (dm.Key && dm.Key !== prefix && dm.IsLatest) {
      files.push({
        name: dm.Key!,
        size: 0,
        etag: '',
        lastModified: dm.LastModified,
        isDeleted: true,
        versionId: dm.VersionId,
      })
    }
  })

  return { files, prefixes }
}

async function listBuckets(client: S3Client): Promise<string[]> {
  const response = await client.send(new ListBucketsCommand({}))
  return (response.Buckets || []).map((b) => b.Name!).filter(Boolean).sort()
}

/** Adds a random UUID before the file extension (or at the end if no extension). */
function makeStorageName(originalName: string): string {
  const uuid = uuidv4()
  const lastDot = originalName.lastIndexOf('.')
  if (lastDot === -1) {
    return `${originalName}-${uuid}`
  }
  const base = originalName.substring(0, lastDot)
  const ext = originalName.substring(lastDot)
  return `${base}-${uuid}${ext}`
}

/** Removes a trailing -uuid (before extension or at end) for display purposes. */
function getDisplayName(storageName: string): string {
  // Matches -xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx before .ext or at end
  return storageName.replace(/-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?=\.|$)/i, '')
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
        // Support same-origin when previewUrl is blank (embedded mode)
        const base = (creds.previewUrl || '').trim().replace(/\/$/, '')
        const previewPath = base ? `${base}/preview` : '/preview'

        const urlObj = new URL(previewPath, window.location.origin)
        urlObj.searchParams.set('bucket', bucket)
        urlObj.searchParams.set('object', objectName)
        urlObj.searchParams.set('w', '280')

        const res = await fetch(urlObj.toString(), {
          signal: controller.signal,
          headers: {
            'X-Minio-Endpoint': creds.endpoint,
            'X-Minio-Access-Key': creds.accessKey,
            'X-Minio-Secret-Key': creds.secretKey,
            'X-Minio-Use-SSL': String(creds.useSSL),
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
  const [notes, setNotes] = useState<Record<string, string>>({})
  const [tooltip, setTooltip] = useState<{ text: string; x: number; y: number } | null>(null)
  const [currentUpload, setCurrentUpload] = useState<{
    name: string
    percent: number
    speed: number
    done: number
    total: number
  } | null>(null)


  // Folder hierarchy for the selected bucket (left sidebar)
  const [prefixChildren, setPrefixChildren] = useState<Record<string, string[]>>({})
  const [expandedPrefixes, setExpandedPrefixes] = useState<Set<string>>(new Set())

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

  // Note modal state
  const [noteModalOpen, setNoteModalOpen] = useState(false)
  const [noteItem, setNoteItem] = useState<FileItem | null>(null)
  const [noteText, setNoteText] = useState('')
  const [isLoadingNote, setIsLoadingNote] = useState(false)
  const [isSavingNote, setIsSavingNote] = useState(false)

  const [loginForm, setLoginForm] = useState(() => {
    // Auto-detect MinIO endpoint:
    // Use the same host the UI is served from, and current port - 2
    let endpoint = '127.0.0.1:7000'
    if (typeof window !== 'undefined') {
      const host = window.location.hostname || '127.0.0.1'
      let currentPort = window.location.port
        ? parseInt(window.location.port, 10)
        : (window.location.protocol === 'https:' ? 443 : 80)
      const minioPort = currentPort - 2
      endpoint = `${host}:${minioPort}`
    }
    return {
      endpoint,
      accessKey: '',
      secretKey: '',
      useSSL: false,
      previewUrl: '', // blank = use same origin (recommended for embedded Go server)
    }
  })

  const isLoggedIn = !!creds && !!client

  // When bucket changes, load its top-level folders for the sidebar tree
  useEffect(() => {
    if (selectedBucket && client) {
      setPrefixChildren({})
      setExpandedPrefixes(new Set())
      setNotes({})
      loadPrefixChildren(selectedBucket, '')
    }
  }, [selectedBucket, client])

  const STORAGE_KEY = 'FAMILY_STORAGE_CREDS'
  const STORAGE_STATE_KEY = 'FAMILY_STORAGE_STATE'

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
          let targetPrefix = ''
          let targetShowDeleted = false
          let targetShowNotes = false
          let targetViewMode: 'grid' | 'list' = 'grid'
          try {
            const saved = sessionStorage.getItem(STORAGE_STATE_KEY)
            if (saved) {
              const parsedState = JSON.parse(saved)
              if (parsedState.selectedBucket && bucketList.includes(parsedState.selectedBucket)) {
                targetBucket = parsedState.selectedBucket
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
            }
          } catch {}

          if (bucketList.length > 0) {
            const bucketToUse = targetBucket || bucketList[0]
            const prefixToUse = (targetBucket && bucketToUse === targetBucket) ? targetPrefix : ''
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
            setSelectedBucket(bucketToUse)
            setCurrentPrefix(prefixToUse)
            setSearch('')
            clearSelection()
            // Load directly with the target prefix and showDeleted
            loadObjects(bucketToUse, prefixToUse, s3Client, parsed, targetShowDeleted).catch(() => {})

            if (prefixToUse) {
              // Auto-expand the folder tree to the restored prefix
              setExpandedPrefixes(prev => {
                const next = new Set(prev)
                let p = ''
                prefixToUse.split('/').filter(Boolean).forEach(part => {
                  p += part + '/'
                  next.add(p)
                })
                return next
              })

              // Preload children for the path so the sidebar tree shows correctly after refresh
              let p = ''
              prefixToUse.split('/').filter(Boolean).forEach(async (part) => {
                p += part + '/'
                try {
                  const { prefixes } = await listObjectsWithPrefix(s3Client, bucketToUse, p, false)
                  setPrefixChildren(prev => ({ ...prev, [p]: prefixes }))
                } catch (e) {
                  console.error('Failed to load prefix children on restore for', p, e)
                }
              })
            }
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

  // Persist UI state (bucket/dir/show-deleted) so refresh keeps the same view
  // Only persist if we actually have a selected bucket (avoid clobbering saved state
  // during the brief moment after login/restore when selectedBucket is still unset)
  useEffect(() => {
    if (isLoggedIn && selectedBucket) {
      const state = {
        selectedBucket,
        currentPrefix,
        showDeleted,
        showNotes,
        viewMode,
      }
      sessionStorage.setItem(STORAGE_STATE_KEY, JSON.stringify(state))
    }
  }, [selectedBucket, currentPrefix, showDeleted, showNotes, viewMode, isLoggedIn])

  const connect = async (form: typeof loginForm) => {
    if (!form.accessKey || !form.secretKey) {
      toast.error('Please enter access key and secret key')
      return
    }

    const newCreds: Credentials = {
      endpoint: form.endpoint.trim(),
      accessKey: form.accessKey.trim(),
      secretKey: form.secretKey.trim(),
      useSSL: form.useSSL,
      previewUrl: form.previewUrl.trim(), // empty = same origin
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

      if (bucketList.length > 0) {
        await selectBucket(bucketList[0], s3Client, newCreds)
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
    setPrefixChildren({})
    setExpandedPrefixes(new Set())
    setNotes({})
    setShowNotes(false)
    setViewMode('grid')
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
    clearSelection()
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
      loadObjects(selectedBucket, currentPrefix, client, creds, showDeleted)
    }
  }, [showDeleted])

  // Load notes for current items when needed for display or note search
  useEffect(() => {
    if (selectedBucket && client && items.length > 0 && (showNotes || searchType === 'note')) {
      loadNotesForItems(items)
    }
  }, [showNotes, searchType, items, selectedBucket, client])

  const navigateTo = (prefix: string) => {
    if (!selectedBucket || !client || !creds) return
    setCurrentPrefix(prefix)
    setSearch('')
    clearSelection()
    loadObjects(selectedBucket, prefix, client, creds, showDeleted)

    // Auto-expand the path in the sidebar tree
    if (prefix) {
      setExpandedPrefixes(prev => {
        const next = new Set(prev)
        let p = ''
        prefix.split('/').filter(Boolean).forEach(part => {
          p += part + '/'
          next.add(p)
          // ensure children are loaded for this level
          if (selectedBucket && !prefixChildren[p]) {
            loadPrefixChildren(selectedBucket, p)
          }
        })
        return next
      })
    }
  }

  const goHome = () => {
    if (selectedBucket) navigateTo('')
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

  const filteredItems = useMemo(() => {
    let result = items
    const q = search.trim().toLowerCase()
    if (q) {
      if (searchType === 'name') {
        result = items.filter(i => i.name.toLowerCase().includes(q))
      } else if (searchType === 'note') {
        result = items.filter(i => {
          const note = notes[i.fullPath] || ''
          return note.toLowerCase().includes(q)
        })
      }
    }
    return [...result].sort((a, b) => {
      if (a.isDir !== b.isDir) return a.isDir ? -1 : 1
      return a.name.localeCompare(b.name)
    })
  }, [items, search, searchType, notes])

  const contentRef = useRef<HTMLDivElement>(null)

  const isInSelectMode = selectedItems.size > 0

  // Load direct child prefixes (folders) for a given prefix in the bucket
  const loadPrefixChildren = async (bucket: string, prefix: string) => {
    if (!client) return
    try {
      // Always load structure without deleted filter for tree
      const { prefixes } = await listObjectsWithPrefix(client, bucket, prefix, false)
      setPrefixChildren(prev => ({ ...prev, [prefix]: prefixes }))
    } catch (e) {
      console.error('Failed to load prefixes for', prefix, e)
    }
  }

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

  const togglePrefix = (prefix: string) => {
    setExpandedPrefixes(prev => {
      const next = new Set(prev)
      if (next.has(prefix)) {
        next.delete(prefix)
      } else {
        next.add(prefix)
        // lazy load children
        if (selectedBucket && !prefixChildren[prefix]) {
          loadPrefixChildren(selectedBucket, prefix)
        }
      }
      return next
    })
  }

  const navigateToPrefix = (prefix: string) => {
    if (!selectedBucket) return
    navigateTo(prefix)
    // ensure expanded
    if (prefix) {
      setExpandedPrefixes(prev => {
        const next = new Set(prev)
        // expand all ancestors
        let p = ''
        prefix.split('/').filter(Boolean).forEach(part => {
          p += part + '/'
          next.add(p)
        })
        return next
      })
    }
  }

  // Recursive tree renderer for folders in sidebar
  const renderPrefixTree = (parentPrefix: string, depth: number): React.ReactNode => {
    const children = prefixChildren[parentPrefix] || []
    return children.map((childPrefix) => {
      const isExpanded = expandedPrefixes.has(childPrefix)
      const folderName = childPrefix.replace(parentPrefix, '').replace(/\/$/, '')
      const isActive = currentPrefix === childPrefix
      return (
        <div key={childPrefix} style={{ marginLeft: `${depth * 12}px` }}>
          <div
            className={`flex items-center gap-1.5 px-2 py-1 text-sm rounded cursor-pointer hover:bg-beige-100 ${isActive ? 'bg-beige-200 font-medium' : 'text-warm-800'}`}
            onClick={() => navigateToPrefix(childPrefix)}
          >
            <span
              onClick={(e) => { e.stopPropagation(); togglePrefix(childPrefix); }}
              className="inline-block w-3 text-center cursor-pointer select-none"
            >
              {isExpanded ? '▼' : '▶'}
            </span>
            <Folder size={14} className="shrink-0 text-beige-600" />
            <span className="truncate">{folderName}</span>
          </div>
          {isExpanded && renderPrefixTree(childPrefix, depth + 1)}
        </div>
      )
    })
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

  const deleteSelectedItems = async () => {
    if (selectedItems.size === 0) return
    const paths = Array.from(selectedItems)
    const toDelete = items.filter(i => paths.includes(i.fullPath) && !i.isDir)

    if (toDelete.length === 0) {
      clearSelection()
      return
    }

    if (!confirm(`Delete ${toDelete.length} item(s)? This cannot be undone.`)) return

    if (!selectedBucket || !client) {
      toast.error('No bucket or client')
      return
    }

    let count = 0
    let errors = 0
    for (const item of toDelete) {
      try {
        await client.send(
          new DeleteObjectCommand({
            Bucket: selectedBucket,
            Key: item.fullPath,
          })
        )
        count++
      } catch (err: any) {
        console.error('Delete failed for', item.name, err)
        errors++
      }
    }

    if (count > 0) {
      toast.success(`Deleted ${count} item(s)`)
    }
    if (errors > 0) {
      toast.error(`Failed to delete ${errors} item(s)`)
    }
    clearSelection()
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

    if (!confirm(`Restore ${toRestore.length} item(s)?`)) return

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

        upload.on('httpUploadProgress', (progress: any) => {
          if (!progress.total) return
          const percent = Math.round((progress.loaded / progress.total) * 100)
          const now = Date.now()
          const timeDiff = (now - lastTime) / 1000
          let speed = 0
          if (timeDiff > 0.1) {
            const bytesDiff = progress.loaded - lastLoaded
            speed = bytesDiff / timeDiff / (1024 * 1024)
            lastLoaded = progress.loaded
            lastTime = now
          }
          setCurrentUpload({
            name: displayName,
            percent,
            speed: parseFloat(speed.toFixed(1)),
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

    const folderName = prompt('Folder name:')
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
      loadPrefixChildren(selectedBucket, currentPrefix)
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
    if (!confirm(`Delete ${item.name}?`)) return

    try {
      await client.send(
        new DeleteObjectCommand({
          Bucket: selectedBucket,
          Key: item.fullPath,
        })
      )
      toast.success(`Deleted ${item.name}`)
      loadObjects(selectedBucket, currentPrefix, client, creds, showDeleted)
    } catch (err: any) {
      toast.error('Delete failed: ' + err.message)
    }
  }

  const restoreFile = async (item: FileItem) => {
    if (!selectedBucket || !client) return
    if (!item.versionId) {
      toast.error('Cannot restore: missing version info')
      return
    }
    if (!confirm(`Restore ${item.name}?`)) return

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

  const handleDrop = async (e: React.DragEvent) => {
    e.preventDefault()

    const items = e.dataTransfer.items
    if (items && items.length > 0) {
      const results: { file: File; relativePath: string }[] = []

      for (let i = 0; i < items.length; i++) {
        const item = items[i]
        const entry = item.webkitGetAsEntry?.()
        if (entry) {
          await processEntry(entry, results)
        }
      }

      if (results.length > 0) {
        await uploadFilesWithStructure(results)
        return
      }
    }

    // fallback for plain files
    if (e.dataTransfer.files.length > 0) {
      await uploadFiles(e.dataTransfer.files)
    }
  }

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault()
  }

  const refresh = () => {
    if (selectedBucket && client && creds) {
      loadObjects(selectedBucket, currentPrefix, client, creds, showDeleted)
    }
  }

  const handleLoginSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    connect(loginForm)
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (previewItem) closePreview()
        if (shareModalOpen) closeShareModal()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [previewItem, shareModalOpen])

  // LOGIN SCREEN
  if (!isLoggedIn) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-warm-50 p-6">
        <div className="w-full max-w-md">
          <div className="mb-8 text-center">
            <div className="inline-flex items-center justify-center w-14 h-14 rounded-2xl bg-beige-200 mb-4">
              <Folder className="text-beige-700" size={28} />
            </div>
            <h1 className="text-3xl font-semibold tracking-tight text-warm-900">Family Storage</h1>
            <p className="text-warm-800 mt-1.5">Connect to your MinIO instance</p>
          </div>

          <div className="card p-8">
            <form onSubmit={handleLoginSubmit} className="space-y-5">
              <div>
                <label className="block text-sm font-medium mb-1.5 text-warm-900">MinIO Endpoint</label>
                <input
                  type="text"
                  className="input"
                  placeholder="host:port (auto-detected as current-host:port-2)"
                  value={loginForm.endpoint}
                  onChange={(e) => setLoginForm({ ...loginForm, endpoint: e.target.value })}
                />
                <p className="text-xs text-beige-700 mt-1">Auto-filled from current host + (port - 2). Edit to override. No protocol.</p>
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium mb-1.5 text-warm-900">Access Key</label>
                  <input
                    type="text"
                    className="input"
                    placeholder="minioadmin"
                    value={loginForm.accessKey}
                    onChange={(e) => setLoginForm({ ...loginForm, accessKey: e.target.value })}
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium mb-1.5 text-warm-900">Secret Key</label>
                  <input
                    type="password"
                    className="input"
                    placeholder="minioadmin"
                    value={loginForm.secretKey}
                    onChange={(e) => setLoginForm({ ...loginForm, secretKey: e.target.value })}
                  />
                </div>
              </div>

              <div>
                <label className="block text-sm font-medium mb-1.5 text-warm-900">Preview Service (optional)</label>
                <input
                  type="text"
                  className="input"
                  placeholder="Leave blank for same origin"
                  value={loginForm.previewUrl}
                  onChange={(e) => setLoginForm({ ...loginForm, previewUrl: e.target.value })}
                />
                <p className="text-xs text-beige-700 mt-1">Leave blank when using the embedded Go server (recommended)</p>
              </div>

              <label className="flex items-center gap-2 text-sm cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={loginForm.useSSL}
                  onChange={(e) => setLoginForm({ ...loginForm, useSSL: e.target.checked })}
                  className="accent-beige-500"
                />
                <span>Use SSL (https)</span>
              </label>

              <button type="submit" className="btn btn-primary w-full mt-2 justify-center">
                Connect to MinIO
              </button>
            </form>

            <div className="mt-6 pt-6 border-t border-beige-200 text-xs text-beige-700">
              Credentials are used only in your browser session. Never stored.
            </div>
          </div>

          <p className="text-center text-xs text-beige-600 mt-6">
            Make sure CORS is enabled on your MinIO server for this origin.
          </p>
        </div>
      </div>
    )
  }

  // MAIN UI (logged in)
  return (
    <div className="flex flex-col min-h-screen bg-warm-50">
      {/* Header */}
      <header className="border-b border-beige-200 bg-white/80 backdrop-blur sticky top-0 z-50">
        <div className="px-6 h-16 flex items-center gap-4">
          {/* Left: logo + searchbar */}
          <div className="flex items-center gap-3 flex-1 min-w-0">
            <div className="flex items-center gap-3 shrink-0">
              <div className="w-9 h-9 rounded-xl bg-beige-300 flex items-center justify-center">
                <Folder size={20} className="text-beige-700" />
              </div>
              <div>
                <div className="font-semibold tracking-tight">Family Storage</div>
                <div className="text-[10px] text-beige-600 -mt-0.5">MinIO • Local</div>
              </div>
            </div>

            {selectedBucket && (
              <input
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search..."
                className="input flex-1 min-w-[12rem] text-sm py-1.5"
              />
            )}
          </div>

          {/* Right: dropdown + endpoint + disconnect */}
          <div className="flex items-center gap-3 text-sm shrink-0">
            {selectedBucket && (
              <select
                value={searchType}
                onChange={(e) => setSearchType(e.target.value as 'name' | 'note')}
                className="input text-sm py-1.5 px-2 w-20"
              >
                <option value="name">Name</option>
                <option value="note">Note</option>
              </select>
            )}

            <div className="px-3 py-1 rounded-full bg-beige-100 text-beige-700 text-xs font-medium">
              {creds?.endpoint}
            </div>
            <button onClick={disconnect} className="btn btn-secondary text-sm py-1.5 px-3.5 gap-2">
              <LogOut size={15} /> Disconnect
            </button>
          </div>
        </div>
      </header>

      <div className="flex flex-1 w-full">
          {/* Sidebar */}
          <div className="w-48 sm:w-56 md:w-64 border-r border-beige-200 bg-white p-3 sm:p-4 flex flex-col">
          <div className="flex items-center justify-between px-1 mb-3">
            <div className="uppercase text-xs tracking-[1px] font-semibold text-beige-600">Buckets</div>
            <button onClick={refresh} className="btn-ghost p-1.5 rounded-md" title="Refresh">
              <RefreshCw size={15} />
            </button>
          </div>

          {buckets.length === 0 && (
            <div className="text-sm text-beige-700 px-1">No buckets found</div>
          )}

          <div className="space-y-1">
            {buckets.map((b) => (
              <React.Fragment key={b}>
                <button
                  onClick={() => selectBucket(b)}
                  className={`w-full text-left px-3 py-2 rounded-lg flex items-center gap-2 text-sm transition-colors ${selectedBucket === b
                    ? 'bg-beige-200 text-warm-900 font-medium'
                    : 'hover:bg-beige-100 text-warm-800'
                    }`}
                >
                  <Folder size={16} className="shrink-0" />
                  <span className="truncate">{b}</span>
                </button>

                {/* Show folder hierarchy for the selected bucket (bucket name acts as root) */}
                {selectedBucket === b && (
                  <div className="ml-4 mt-1 mb-2 space-y-0.5 text-sm">
                    {renderPrefixTree('', 0)}
                  </div>
                )}
              </React.Fragment>
            ))}
          </div>

          <div className="mt-auto pt-6 text-[11px] text-beige-600 px-1">
            Preview images are generated and cached by the Go backend.
          </div>
        </div>

        {/* Main */}
        <div className="flex-1 flex flex-col min-w-0">
          <div className="h-14 border-b border-beige-200 bg-white flex items-center px-4 sm:px-6 gap-3">
            <div className="flex items-center gap-2 flex-1 min-w-0">
              {selectedBucket && (
                <div className="flex items-center gap-1 text-sm">
                  <button onClick={goHome} className="flex items-center gap-1.5 hover:text-beige-700 text-warm-900">
                    <Home size={15} /> {selectedBucket}
                  </button>
                  {breadcrumbs.map((crumb, idx) => (
                    <span key={idx} className="flex items-center gap-1 text-beige-500">
                      <ChevronRight size={14} />
                      <button onClick={() => navigateTo(crumb.prefix)} className="hover:text-beige-700 text-warm-800">
                        {crumb.label}
                      </button>
                    </span>
                  ))}
                </div>
              )}
            </div>

            <div className="flex items-center gap-2">
              {isInSelectMode && (
                <div className="flex items-center gap-2 text-sm">
                  <span className="px-2 py-1 bg-blue-100 text-blue-700 rounded text-xs font-medium">
                    {selectedItems.size} selected
                  </span>
                  <button
                    onClick={downloadSelectedItems}
                    className="btn btn-primary text-xs py-1 px-2"
                  >
                    Download selected
                  </button>
                  <button
                    onClick={restoreSelectedItems}
                    className="btn btn-secondary text-xs py-1 px-2 text-green-600 hover:bg-green-50"
                  >
                    Restore selected
                  </button>
                  <button
                    onClick={deleteSelectedItems}
                    className="btn btn-secondary text-xs py-1 px-2 text-red-600 hover:bg-red-50"
                  >
                    Delete selected
                  </button>
                  <button onClick={clearSelection} className="btn btn-secondary text-xs py-1 px-2">
                    Clear
                  </button>
                </div>
              )}

              <button
                onClick={() => setShowDeleted(!showDeleted)}
                className={`btn ${showDeleted ? 'btn-primary' : 'btn-secondary'} text-xs py-1 px-2 flex items-center gap-1`}
                title={showDeleted ? 'Hide deleted photos' : 'Show deleted photos (including delete markers)'}
              >
                {showDeleted ? <EyeOff size={14} /> : <Eye size={14} />}
                {showDeleted ? 'Hide deleted' : 'Show deleted'}
              </button>

              <button
                onClick={() => setShowNotes(!showNotes)}
                className={`btn ${showNotes ? 'btn-primary' : 'btn-secondary'} text-xs py-1 px-2 flex items-center gap-1`}
                title={showNotes ? 'Hide notes' : 'Show notes (tooltips on hover when off)'}
              >
                <MessageSquare size={14} />
                {showNotes ? 'Hide notes' : 'Show notes'}
              </button>

              {/* View toggle: grid / list (minimal) */}
              <div className="flex items-center border border-beige-200 rounded-lg overflow-hidden">
                <button
                  onClick={() => setViewMode('grid')}
                  className={`px-2 py-1 text-xs flex items-center ${viewMode === 'grid' ? 'bg-beige-200 text-warm-900' : 'hover:bg-beige-100 text-beige-700'}`}
                  title="Grid view"
                >
                  <LayoutGrid size={14} />
                </button>
                <button
                  onClick={() => setViewMode('list')}
                  className={`px-2 py-1 text-xs flex items-center ${viewMode === 'list' ? 'bg-beige-200 text-warm-900' : 'hover:bg-beige-100 text-beige-700'}`}
                  title="List view"
                >
                  <List size={14} />
                </button>
              </div>

              {selectedBucket && (
                <button onClick={createFolder} className="btn btn-secondary">
                  <FolderPlus size={16} /> Create folder
                </button>
              )}

              <label className="btn btn-primary cursor-pointer">
                <UploadIcon size={16} />
                Upload files
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

              <label className="btn btn-secondary cursor-pointer">
                <UploadIcon size={16} />
                Upload folder
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

              <button onClick={refresh} className="btn btn-secondary">
                <RefreshCw size={16} /> Refresh
              </button>
            </div>
          </div>

          <div
            ref={contentRef}
            className={`flex-1 p-4 sm:p-6 overflow-auto relative ${isDragSelecting ? 'select-none' : ''}`}
            onDrop={handleDrop}
            onDragOver={handleDragOver}
            onMouseDown={handleMouseDown}
            onMouseMove={handleMouseMove}
            onMouseUp={handleMouseUp}
            onMouseLeave={handleMouseUp}
          >
            {!selectedBucket ? (
              <div className="h-[60vh] flex items-center justify-center text-center">
                <div>
                  <div className="text-beige-500 mb-2"><Folder size={48} className="mx-auto" /></div>
                  <div className="text-lg font-medium">Select a bucket to begin</div>
                </div>
              </div>
            ) : (
              <>
                <div className="mb-5 border border-dashed border-beige-300 rounded-2xl bg-white/60 py-3 text-center text-sm text-beige-700">
                  Drop files here to upload to <span className="font-medium text-warm-900">{currentPrefix || '/'}</span>
                </div>

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

                {loading ? (
                  viewMode === 'grid' ? (
                    <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 2xl:grid-cols-7 gap-4">
                      {Array.from({ length: 8 }).map((_, i) => (
                        <div key={i} className="card h-44 animate-pulse bg-beige-100" />
                      ))}
                    </div>
                  ) : (
                    <div className="border border-beige-200 rounded-xl bg-white overflow-hidden">
                      {Array.from({ length: 6 }).map((_, i) => (
                        <div key={i} className="h-9 bg-beige-100 animate-pulse border-b border-beige-200 last:border-b-0" />
                      ))}
                    </div>
                  )
                ) : filteredItems.length === 0 ? (
                  <div className="text-center py-16 text-beige-700">
                    {search ? 'No matching files' : 'This folder is empty'}
                  </div>
                ) : viewMode === 'grid' ? (
                  <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 2xl:grid-cols-7 gap-4 items-start">
                    {filteredItems.map((item, index) => (
                      <div 
                        key={index} 
                        className={`file-item card flex flex-col group relative overflow-visible ${item.isDeleted ? 'opacity-60' : ''}`} 
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
                          <button onClick={() => navigateTo(item.fullPath)} className="flex-1 p-3 flex flex-col">
                            <div className="thumbnail w-full h-40 flex items-center justify-center bg-beige-100 group-hover:bg-beige-200 transition-colors">
                              <Folder size={46} className="text-beige-600" />
                            </div>
                            <div className="pt-3 px-1">
                              <div className="font-medium text-sm truncate">{item.name}</div>
                              <div className="text-xs text-beige-600">Folder</div>
                            </div>
                          </button>
                        ) : (
                          <>
                            <div className="relative overflow-hidden">
                              <div
                                className="cursor-pointer"
                                onClick={() => {
                                  if (isInSelectMode) {
                                    toggleSelect(item.fullPath)
                                  } else if (!item.isDeleted) {
                                    isImage(item.name) ? openPreview(item) : downloadFile(item)
                                  }
                                }}
                              >
                                {/* Select icon top-left */}
                                <div
                                  className="absolute top-2 left-2 z-30"
                                  onClick={(e) => {
                                    e.stopPropagation()
                                    toggleSelect(item.fullPath)
                                  }}
                                >
                                  <div
                                    className={`w-4 h-4 rounded border flex items-center justify-center transition-colors ${
                                      selectedItems.has(item.fullPath)
                                        ? 'bg-blue-500 border-blue-500'
                                        : 'bg-white/80 border-gray-300 hover:border-blue-400'
                                    }`}
                                  >
                                    {selectedItems.has(item.fullPath) && <Check size={10} className="text-white" />}
                                  </div>
                                </div>

                                {item.isDeleted ? (
                                  <div className="thumbnail w-full h-40 bg-red-50 flex items-center justify-center">
                                    <Trash2 size={42} className="text-red-400" />
                                  </div>
                                ) : isImage(item.name) && creds ? (
                                  <ObjectThumbnail
                                    bucket={selectedBucket}
                                    objectName={item.fullPath}
                                    creds={creds}
                                  />
                                ) : (
                                  <div className="thumbnail w-full h-40 bg-beige-50">
                                    <File size={42} className="text-beige-500" />
                                  </div>
                                )}
                              </div>

                              {/* Hover action buttons - top right over the photo */}
                              <div className="absolute top-2 right-2 flex gap-1.5 opacity-0 group-hover:opacity-100 transition-all z-10">
                                {item.isDeleted ? (
                                  <button
                                    onClick={(e) => { e.stopPropagation(); restoreFile(item); }}
                                    className="bg-white/90 hover:bg-green-50 text-green-600 p-1.5 rounded-lg shadow-sm hover:shadow transition-colors"
                                    title="Restore"
                                  >
                                    <RotateCcw size={15} />
                                  </button>
                                ) : (
                                  <>
                                    <button
                                      onClick={(e) => { e.stopPropagation(); downloadFile(item); }}
                                      className="bg-white/90 hover:bg-white text-beige-700 p-1.5 rounded-lg shadow-sm hover:shadow transition-colors"
                                      title="Download"
                                    >
                                      <Download size={15} />
                                    </button>
                                    <button
                                      onClick={(e) => { e.stopPropagation(); openShareModal(item); }}
                                      className="bg-white/90 hover:bg-white text-beige-700 p-1.5 rounded-lg shadow-sm hover:shadow transition-colors"
                                      title="Get shareable download link"
                                    >
                                      <Link size={15} />
                                    </button>
                                    <button
                                      onClick={(e) => { e.stopPropagation(); openNoteModal(item); }}
                                      className="bg-white/90 hover:bg-white text-beige-700 p-1.5 rounded-lg shadow-sm hover:shadow transition-colors"
                                      title="Add/Edit note"
                                    >
                                      <MessageSquare size={15} />
                                    </button>
                                  </>
                                )}
                                <button
                                  onClick={(e) => { e.stopPropagation(); deleteFile(item); }}
                                  className="bg-white/90 hover:bg-red-50 text-red-600 p-1.5 rounded-lg shadow-sm hover:shadow transition-colors"
                                  title={item.isDeleted ? "Permanently delete" : "Delete"}
                                >
                                  <Trash2 size={15} />
                                </button>
                              </div>
                            </div>

                            {/* Compact bottom info: only name + date + size */}
                            <div className="p-2.5">
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
                                <div className="mt-1 text-sm text-black break-words" title={notes[item.fullPath]}>
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
                  <div className="divide-y divide-beige-200 border border-beige-200 rounded-xl bg-white overflow-hidden">
                    {filteredItems.map((item, index) => {
                      const isSelected = selectedItems.has(item.fullPath)
                      return (
                        <div
                          key={index}
                          className={`flex items-center gap-3 px-3 py-1.5 group text-sm hover:bg-beige-50 transition-colors ${item.isDeleted ? 'opacity-60' : ''} ${isSelected ? 'bg-blue-50/40' : ''}`}
                          data-fullpath={item.fullPath}
                          data-isdir={item.isDir ? 'true' : 'false'}
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
                          {/* Select checkbox */}
                          <div
                            className={`w-4 h-4 rounded border flex items-center justify-center shrink-0 cursor-pointer transition-colors ${isSelected ? 'bg-blue-500 border-blue-500' : 'bg-white border-gray-300 hover:border-blue-400'}`}
                            onClick={(e) => { e.stopPropagation(); toggleSelect(item.fullPath) }}
                          >
                            {isSelected && <Check size={10} className="text-white" />}
                          </div>

                          {/* Icon (no preview) */}
                          <div className="shrink-0 text-beige-600">
                            {item.isDir ? <Folder size={16} /> : <File size={16} />}
                          </div>

                          {/* Name */}
                          <div
                            className={`flex-1 min-w-0 truncate font-medium cursor-pointer hover:underline ${item.isDeleted ? 'line-through text-red-400' : 'text-warm-900'}`}
                            onClick={() => {
                              if (item.isDir) {
                                navigateTo(item.fullPath)
                              } else if (isInSelectMode) {
                                toggleSelect(item.fullPath)
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
                            <div className="max-w-[220px] truncate text-xs text-black" title={notes[item.fullPath]}>
                              {notes[item.fullPath]}
                            </div>
                          )}

                          {/* Size */}
                          <div className="w-16 text-right text-[11px] text-beige-600 shrink-0 tabular-nums">
                            {item.isDir ? '—' : formatSize(item.size)}
                          </div>

                          {/* Date */}
                          <div className="w-[70px] text-right text-[11px] text-beige-600 shrink-0">
                            {item.lastModified ? format(item.lastModified, 'MMM d') : '—'}
                          </div>

                          {/* Minimal actions (shown on hover, files only) */}
                          {!item.isDir ? (
                            <div className="flex gap-0.5 opacity-0 group-hover:opacity-100 transition shrink-0">
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
                                </>
                              )}
                              <button onClick={(e) => { e.stopPropagation(); deleteFile(item) }} className="p-1 rounded hover:bg-red-100 text-red-600" title="Delete">
                                <Trash2 size={14} />
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
          <div className="modal-content w-full max-w-5xl" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between px-5 py-3 border-b border-beige-200 bg-beige-50">
              <div className="font-medium truncate pr-4">{previewItem.name}</div>
              <div className="flex items-center gap-2">
                <button onClick={() => downloadFile(previewItem)} className="btn btn-secondary text-sm">
                  <Download size={15} /> Download
                </button>
                <button onClick={closePreview} className="btn btn-ghost p-2">
                  <X size={18} />
                </button>
              </div>
            </div>
            <div className="p-5 bg-beige-100 flex items-center justify-center overflow-auto" style={{ maxHeight: '80vh' }}>
              <img
                src={previewUrl}
                alt={previewItem.name}
                className="max-w-full max-h-[72vh] object-contain rounded-lg shadow-sm bg-white"
              />
            </div>
            <div className="px-5 py-2.5 text-xs border-t border-beige-200 bg-white text-beige-600 flex justify-between">
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

      {/* Cursor-following tooltip for notes */}
      {tooltip && !showNotes && (
        <div 
          className="fixed z-[100] pointer-events-none bg-beige-50 border border-beige-200 text-black text-sm px-3 py-2 rounded-lg shadow-md max-w-[280px] whitespace-pre-wrap break-words"
          style={{ 
            left: `${tooltip.x + 12}px`, 
            top: `${tooltip.y + 12}px` 
          }}
        >
          {tooltip.text}
        </div>
      )}

      <div className="text-center py-3 text-[11px] text-beige-600 border-t border-beige-200 bg-white">
        Images are previewed via cached Go backend. Full resolution uses presigned MinIO URLs.
      </div>
    </div>
  )
}

export default App
