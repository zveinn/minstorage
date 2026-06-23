import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  S3Client,
  ListBucketsCommand,
  ListObjectsV2Command,
  ListObjectVersionsCommand,
  DeleteObjectCommand,
  GetObjectCommand,
} from '@aws-sdk/client-s3'
import { Upload } from '@aws-sdk/lib-storage'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import {
  Upload as UploadIcon, Download, Trash2, Folder, File, Image as ImageIcon, RefreshCw,
  LogOut, Search, ChevronRight, Home, X, Check, Eye, EyeOff
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

    const prefixes = (response.CommonPrefixes || [])
      .map((p) => p.Prefix!)
      .filter(Boolean)

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

  const prefixes = (response.CommonPrefixes || [])
    .map((p) => p.Prefix!)
    .filter(Boolean)

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
  const [showDeleted, setShowDeleted] = useState(false)
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
      loadPrefixChildren(selectedBucket, '')
    }
  }, [selectedBucket, client])

  const STORAGE_KEY = 'FAMILY_STORAGE_CREDS'

  // Restore credentials from sessionStorage on mount
  useEffect(() => {
    const stored = sessionStorage.getItem(STORAGE_KEY)
    if (!stored) return

    try {
      const parsed: Credentials = JSON.parse(stored)
      const s3Client = getS3Client(parsed)

      setCreds(parsed)
      setClient(s3Client)

      // Try to restore buckets and auto-select first one (like after login)
      listBuckets(s3Client)
        .then((bucketList) => {
          setBuckets(bucketList)
          if (bucketList.length > 0) {
            selectBucket(bucketList[0], s3Client, parsed).catch(() => {})
          }
        })
        .catch((err) => {
          console.error('Failed to restore MinIO session:', err)
          // Stored credentials are no longer valid
          sessionStorage.removeItem(STORAGE_KEY)
          setCreds(null)
          setClient(null)
          setBuckets([])
        })
    } catch (e) {
      console.error('Invalid stored credentials')
      sessionStorage.removeItem(STORAGE_KEY)
    }
  }, []) // run only once on mount

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
    setCreds(null)
    setClient(null)
    setBuckets([])
    setSelectedBucket(null)
    setItems([])
    setCurrentPrefix('')
    setSearch('')
    setPreviewItem(null)
    setPreviewUrl(null)
    clearSelection()
    setPrefixChildren({})
    setExpandedPrefixes(new Set())
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
    if (search.trim()) {
      const q = search.toLowerCase()
      result = items.filter(i => i.name.toLowerCase().includes(q))
    }
    return [...result].sort((a, b) => {
      if (a.isDir !== b.isDir) return a.isDir ? -1 : 1
      return a.name.localeCompare(b.name)
    })
  }, [items, search])

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

  const getPresignedDownloadUrl = async (item: FileItem): Promise<string> => {
    if (!selectedBucket || !client) throw new Error('No client')
    const command = new GetObjectCommand({
      Bucket: selectedBucket,
      Key: item.fullPath,
      ResponseContentDisposition: `attachment; filename="${item.name}"`,
    })
    return getSignedUrl(client, command, { expiresIn: 60 * 5 })
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
  }

  const handleMouseMove = (e: React.MouseEvent) => {
    if (!isDragSelecting) return
    const pos = getRelativePosition(e)
    setDragCurrentPos(pos)
  }

  const handleMouseUp = () => {
    if (!isDragSelecting) return
    setIsDragSelecting(false)

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
      if (e.key === 'Escape' && previewItem) closePreview()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [previewItem])

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

  // MAIN UI
  return (
    <div className="flex flex-col min-h-screen bg-warm-50">
      {/* Header */}
      <header className="border-b border-beige-200 bg-white/80 backdrop-blur sticky top-0 z-50">
        <div className="px-6 h-16 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-xl bg-beige-300 flex items-center justify-center">
              <Folder size={20} className="text-beige-700" />
            </div>
            <div>
              <div className="font-semibold tracking-tight">Family Storage</div>
              <div className="text-[10px] text-beige-600 -mt-0.5">MinIO • Local</div>
            </div>
          </div>

          <div className="flex items-center gap-3 text-sm">
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
              <div className="relative w-48 sm:w-64">
                <input
                  type="text"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Search files..."
                  className="input pl-9 py-1.5 text-sm"
                />
                <Search size={15} className="absolute left-3 top-2.5 text-beige-600" />
              </div>

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
            className="flex-1 p-4 sm:p-6 overflow-auto relative"
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
                  Drop files or folders here to upload to <span className="font-medium text-warm-900">{currentPrefix || '/'}</span>
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
                  <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 2xl:grid-cols-7 gap-4">
                    {Array.from({ length: 8 }).map((_, i) => (
                      <div key={i} className="card h-44 animate-pulse bg-beige-100" />
                    ))}
                  </div>
                ) : filteredItems.length === 0 ? (
                  <div className="text-center py-16 text-beige-700">
                    {search ? 'No matching files' : 'This folder is empty'}
                  </div>
                ) : (
                  <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 2xl:grid-cols-7 gap-4">
                    {filteredItems.map((item, index) => (
                      <div key={index} className={`file-item card overflow-hidden flex flex-col group ${item.isDeleted ? 'opacity-60' : ''}`} data-fullpath={item.fullPath} data-isdir={item.isDir ? 'true' : 'false'}>
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
                                {!item.isDeleted && (
                                  <button
                                    onClick={(e) => { e.stopPropagation(); downloadFile(item); }}
                                    className="bg-white/90 hover:bg-white text-beige-700 p-1.5 rounded-lg shadow-sm hover:shadow transition-colors"
                                    title="Download"
                                  >
                                    <Download size={15} />
                                  </button>
                                )}
                                <button
                                  onClick={(e) => { e.stopPropagation(); deleteFile(item); }}
                                  className="bg-white/90 hover:bg-red-50 text-red-600 p-1.5 rounded-lg shadow-sm hover:shadow transition-colors"
                                  title={item.isDeleted ? "Permanently delete (remove marker)" : "Delete"}
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
                            </div>
                          </>
                        )}
                      </div>
                    ))}
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

      <div className="text-center py-3 text-[11px] text-beige-600 border-t border-beige-200 bg-white">
        Images are previewed via cached Go backend. Full resolution uses presigned MinIO URLs.
      </div>
    </div>
  )
}

export default App
