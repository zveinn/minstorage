import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  S3Client,
  ListBucketsCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand,
} from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import {
  Upload, Download, Trash2, Folder, File, Image as ImageIcon, RefreshCw,
  LogOut, Search, ChevronRight, Home, X
} from 'lucide-react'
import { format } from 'date-fns'
import { toast } from 'sonner'
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
}

interface UploadProgress {
  name: string
  progress: number
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
  prefix: string
): Promise<{ files: any[]; prefixes: string[] }> {
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
    }))

  return { files, prefixes }
}

async function listBuckets(client: S3Client): Promise<string[]> {
  const response = await client.send(new ListBucketsCommand({}))
  return (response.Buckets || []).map((b) => b.Name!).filter(Boolean).sort()
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
  const [uploadQueue, setUploadQueue] = useState<UploadProgress[]>([])

  const [previewItem, setPreviewItem] = useState<FileItem | null>(null)
  const [previewUrl, setPreviewUrl] = useState<string | null>(null)

  const [loginForm, setLoginForm] = useState({
    endpoint: '127.0.0.1:7000',
    accessKey: '',
    secretKey: '',
    useSSL: false,
    previewUrl: '', // blank = use same origin (recommended for embedded Go server)
  })

  const isLoggedIn = !!creds && !!client

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
      toast.success('Connected to MinIO')
    } catch (err: any) {
      console.error(err)
      toast.error('Failed to connect: ' + (err.message || 'Check credentials and CORS'))
    }
  }

  const disconnect = () => {
    setCreds(null)
    setClient(null)
    setBuckets([])
    setSelectedBucket(null)
    setItems([])
    setCurrentPrefix('')
    setSearch('')
    setUploadQueue([])
    setPreviewItem(null)
    setPreviewUrl(null)
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
    await loadObjects(bucket, '', activeClient, activeCreds)
  }, [client, creds])

  const loadObjects = async (
    bucket: string,
    prefix: string,
    c?: S3Client,
    _cr?: Credentials
  ) => {
    const activeClient = c || client
    if (!activeClient) return

    setLoading(true)
    try {
      const { files, prefixes } = await listObjectsWithPrefix(activeClient, bucket, prefix)

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
            name: f.name.replace(prefix, ''),
            fullPath: f.name,
            size: f.size,
            lastModified: f.lastModified,
            isDir: false,
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

  const navigateTo = (prefix: string) => {
    if (!selectedBucket || !client || !creds) return
    setCurrentPrefix(prefix)
    setSearch('')
    loadObjects(selectedBucket, prefix, client, creds)
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

  const uploadFiles = async (files: FileList | File[]) => {
    if (!selectedBucket || !client || !creds) {
      toast.error('Select a bucket first')
      return
    }

    const fileArray = Array.from(files)
    if (fileArray.length === 0) return

    const newUploads: UploadProgress[] = fileArray.map(f => ({ name: f.name, progress: 0 }))
    setUploadQueue(prev => [...prev, ...newUploads])

    for (const file of fileArray) {
      const objectName = currentPrefix + file.name

      try {
        setUploadQueue(q => q.map(u => u.name === file.name ? { ...u, progress: 10 } : u))

        await client.send(
          new PutObjectCommand({
            Bucket: selectedBucket,
            Key: objectName,
            Body: file,
            ContentType: file.type || 'application/octet-stream',
          })
        )

        setUploadQueue(q => q.map(u => u.name === file.name ? { ...u, progress: 100 } : u))
        toast.success(`Uploaded ${file.name}`)
      } catch (err: any) {
        console.error(err)
        toast.error(`Upload failed: ${file.name}`)
      }
    }

    setTimeout(() => {
      setUploadQueue([])
      if (selectedBucket && client && creds) {
        loadObjects(selectedBucket, currentPrefix, client, creds)
      }
    }, 650)
  }

  const downloadFile = async (item: FileItem) => {
    if (!selectedBucket || !client) return

    try {
      const command = new GetObjectCommand({
        Bucket: selectedBucket,
        Key: item.fullPath,
      })
      const url = await getSignedUrl(client, command, { expiresIn: 60 * 5 })
      const a = document.createElement('a')
      a.href = url
      a.download = item.name
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
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
      loadObjects(selectedBucket, currentPrefix, client, creds)
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

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault()
    if (e.dataTransfer.files.length > 0) {
      uploadFiles(e.dataTransfer.files)
    }
  }

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault()
  }

  const refresh = () => {
    if (selectedBucket && client && creds) {
      loadObjects(selectedBucket, currentPrefix, client, creds)
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
                  placeholder="127.0.0.1:7000"
                  value={loginForm.endpoint}
                  onChange={(e) => setLoginForm({ ...loginForm, endpoint: e.target.value })}
                />
                <p className="text-xs text-beige-700 mt-1">Host:port — no protocol</p>
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
        <div className="max-w-[1280px] mx-auto px-6 h-16 flex items-center justify-between">
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

      <div className="flex flex-1 max-w-[1280px] mx-auto w-full">
        {/* Sidebar */}
        <div className="w-64 border-r border-beige-200 bg-white p-4 flex flex-col">
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
              <button
                key={b}
                onClick={() => selectBucket(b)}
                className={`w-full text-left px-3 py-2 rounded-lg flex items-center gap-2 text-sm transition-colors ${selectedBucket === b
                  ? 'bg-beige-200 text-warm-900 font-medium'
                  : 'hover:bg-beige-100 text-warm-800'
                  }`}
              >
                <Folder size={16} className="shrink-0" />
                <span className="truncate">{b}</span>
              </button>
            ))}
          </div>

          <div className="mt-auto pt-6 text-[11px] text-beige-600 px-1">
            Preview images are generated and cached by the Go backend.
          </div>
        </div>

        {/* Main */}
        <div className="flex-1 flex flex-col min-w-0">
          <div className="h-14 border-b border-beige-200 bg-white flex items-center px-6 gap-3">
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
              <div className="relative w-64">
                <input
                  type="text"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Search files..."
                  className="input pl-9 py-1.5 text-sm"
                />
                <Search size={15} className="absolute left-3 top-2.5 text-beige-600" />
              </div>

              <label className="btn btn-primary cursor-pointer">
                <Upload size={16} />
                Upload
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

              <button onClick={refresh} className="btn btn-secondary">
                <RefreshCw size={16} /> Refresh
              </button>
            </div>
          </div>

          <div
            className="flex-1 p-6 overflow-auto"
            onDrop={handleDrop}
            onDragOver={handleDragOver}
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

                {uploadQueue.length > 0 && (
                  <div className="mb-5 card p-4">
                    <div className="text-xs uppercase tracking-widest mb-3 text-beige-600 font-semibold">Uploading</div>
                    {uploadQueue.map((u, i) => (
                      <div key={i} className="flex items-center gap-3 text-sm mb-2 last:mb-0">
                        <div className="flex-1 truncate">{u.name}</div>
                        <div className="w-28 h-1.5 bg-beige-200 rounded overflow-hidden">
                          <div className="h-full bg-beige-500 transition-all" style={{ width: `${u.progress}%` }} />
                        </div>
                      </div>
                    ))}
                  </div>
                )}

                {loading ? (
                  <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-4">
                    {Array.from({ length: 8 }).map((_, i) => (
                      <div key={i} className="card h-52 animate-pulse bg-beige-100" />
                    ))}
                  </div>
                ) : filteredItems.length === 0 ? (
                  <div className="text-center py-16 text-beige-700">
                    {search ? 'No matching files' : 'This folder is empty'}
                  </div>
                ) : (
                  <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 2xl:grid-cols-7 gap-4">
                    {filteredItems.map((item, index) => (
                      <div key={index} className="file-item card overflow-hidden flex flex-col group">
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
                            <div
                              className="cursor-pointer"
                              onClick={() => isImage(item.name) ? openPreview(item) : downloadFile(item)}
                            >
                              {isImage(item.name) && creds ? (
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

                            <div className="p-3 flex-1 flex flex-col">
                              <div
                                onClick={() => isImage(item.name) ? openPreview(item) : downloadFile(item)}
                                className="font-medium text-sm leading-snug truncate cursor-pointer hover:underline"
                              >
                                {item.name}
                              </div>

                              <div className="mt-auto pt-3 flex items-center justify-between text-xs text-beige-600">
                                <span>{formatSize(item.size)}</span>
                                {item.lastModified && <span>{format(item.lastModified, 'MMM d')}</span>}
                              </div>

                              <div className="flex gap-1.5 pt-3 opacity-0 group-hover:opacity-100 transition-opacity">
                                <button onClick={() => downloadFile(item)} className="btn btn-ghost flex-1 justify-center text-xs py-1">
                                  <Download size={14} /> Download
                                </button>
                                <button onClick={() => deleteFile(item)} className="btn btn-ghost text-red-600 hover:bg-red-50 px-2" title="Delete">
                                  <Trash2 size={14} />
                                </button>
                              </div>
                            </div>
                          </>
                        )}
                      </div>
                    ))}
                  </div>
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
