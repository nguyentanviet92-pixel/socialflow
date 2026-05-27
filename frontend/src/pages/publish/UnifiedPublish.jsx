import { useState, useMemo, useEffect } from 'react'
import { useSearchParams, useLocation, useNavigate } from 'react-router-dom'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import {
  Send, Sparkles, Hash, Image, Film, X, Loader, Clock,
  CheckCircle, AlertCircle, Ban, XCircle, RotateCcw, Loader2,
  CalendarClock, Zap, ChevronDown, ChevronUp, FileText, Users,
  Shuffle, ImageOff, RefreshCw, Plus, Check, ExternalLink, Wand2,
} from 'lucide-react'
import toast from 'react-hot-toast'
import api from '../../lib/api'
import HashtagSection from '../../components/content/HashtagSection'
import ContentList from '../content/ContentList'
import ContentComposer from '../content/ContentComposer'
import MediaLibrary from '../media/MediaLibrary'
import InboxPage from '../inbox/InboxPage'

const stylePresets = [
  { value: 'casual', label: 'Than mat', emoji: '😊' },
  { value: 'professional', label: 'Chuyen nghiep', emoji: '💼' },
  { value: 'viral', label: 'Viral', emoji: '🔥' },
  { value: 'educational', label: 'Giao duc', emoji: '📚' },
  { value: 'story', label: 'Ke chuyen', emoji: '📖' },
  { value: 'promotional', label: 'Quang cao', emoji: '🎯' },
]

const statusConfig = {
  pending: { icon: Clock, label: 'Cho', cls: 'bg-yellow-100 text-yellow-700' },
  claimed: { icon: Loader2, label: 'Dang xu ly', cls: 'bg-blue-100 text-info' },
  running: { icon: Loader2, label: 'Dang chay', cls: 'bg-blue-100 text-info' },
  done: { icon: CheckCircle, label: 'Xong', cls: 'bg-green-100 text-hermes' },
  failed: { icon: AlertCircle, label: 'Loi', cls: 'bg-red-100 text-red-700' },
  cancelled: { icon: Ban, label: 'Huy', cls: 'bg-app-elevated text-app-muted' },
}

const typeLabels = {
  post_page: 'Trang', post_page_graph: 'Trang (API)', post_group: 'Nhom', post_profile: 'Ca nhan',
  scan_group_keyword: 'Quet group', discover_groups_keyword: 'Tim group', check_engagement: 'Tuong tac',
}

const aiImageSizes = [
  { value: 'landscape_4_3', label: '4:3 ngang' },
  { value: 'landscape_16_9', label: '16:9 ngang' },
  { value: 'square', label: 'Vuông' },
  { value: 'square_hd', label: 'Vuông HD' },
  { value: 'portrait_4_3', label: '4:3 dọc' },
  { value: 'portrait_16_9', label: '16:9 dọc' },
]

const MODEL_ALLOWED_SIZES = {
  'fal-ai/flux/schnell': ['square', 'square_hd', 'landscape_4_3', 'landscape_16_9', 'portrait_4_3', 'portrait_16_9'],
  'fal-ai/flux/dev': ['square', 'square_hd', 'landscape_4_3', 'landscape_16_9', 'portrait_4_3', 'portrait_16_9'],
  'fal-ai/flux-pro/v1.1': ['square', 'square_hd', 'landscape_4_3', 'landscape_16_9', 'portrait_4_3', 'portrait_16_9'],
  'fal-ai/flux.2/dev': ['square', 'square_hd', 'landscape_4_3', 'landscape_16_9', 'portrait_4_3', 'portrait_16_9'],
  'fal-ai/nano-banana-2': ['square', 'landscape_16_9', 'portrait_16_9', 'landscape_4_3', 'portrait_4_3'],
  'fal-ai/nano-banana-pro': ['square', 'landscape_16_9', 'portrait_16_9', 'landscape_4_3', 'portrait_4_3'],
  'fal-ai/recraft-v3': ['square', 'landscape_16_9', 'portrait_16_9', 'landscape_4_3', 'portrait_4_3'],
  'fal-ai/recraft-v4': ['square', 'landscape_16_9', 'portrait_16_9', 'landscape_4_3', 'portrait_4_3'],
  'fal-ai/ideogram/v3': ['square', 'landscape_16_9', 'portrait_16_9', 'landscape_4_3', 'portrait_4_3'],
  'fal-ai/qwen-image-max': ['square', 'landscape_16_9', 'portrait_16_9', 'landscape_4_3', 'portrait_4_3'],
}

function PublishTab() {
  const queryClient = useQueryClient()
  const [searchParams, setSearchParams] = useSearchParams()

  // === Step 1: Account ===
  const [selectedAccountId, setSelectedAccountId] = useState('')

  // === Step 2: Post Type ===
  const [postType, setPostType] = useState('page') // 'page' | 'group'

  // === Step 3a: Fanpage mode ===
  const [mainPageId, setMainPageId] = useState('')

  // === URL params pre-selection ===
  const [pendingPageId, setPendingPageId] = useState(null)
  const [pendingGroupId, setPendingGroupId] = useState(null)
  const [ccEnabled, setCcEnabled] = useState(false)
  const [ccPages, setCcPages] = useState({}) // { [pageId]: { selected: bool, rewrite: bool } }

  // === Step 3b: Group mode ===
  const [groupSelections, setGroupSelections] = useState({}) // { [groupId]: { selected: bool, rewrite: bool } }

  // === Profile (optional in both modes) ===
  const [includeProfile, setIncludeProfile] = useState(false)

  // === Step 4: Content ===
  const [inputBrief, setInputBrief] = useState('')
  const [referenceUrl, setReferenceUrl] = useState('')
  const [caption, setCaption] = useState('')
  const [hashtags, setHashtags] = useState('')
  const [aiStyle, setAiStyle] = useState('casual')
  const [aiLang, setAiLang] = useState('vi')

  // === Step 5: Media ===
  const [mediaMode, setMediaMode] = useState('selected') // 'selected' | 'random' | 'none'
  const [mediaId, setMediaId] = useState('')
  const [mediaSearch, setMediaSearch] = useState('')
  const [mediaFilter, setMediaFilter] = useState('all') // all, ai, uploaded
  const [randomSource, setRandomSource] = useState('library') // 'library' | 'local'
  const [localMediaFiles, setLocalMediaFiles] = useState([]) // files from local folder

  // === AI Image Generation ===
  const [showAiImageGen, setShowAiImageGen] = useState(false)
  const [aiImagePrompt, setAiImagePrompt] = useState('')
  const [aiImageModel, setAiImageModel] = useState('fal-ai/flux/schnell')
  const [aiImageSize, setAiImageSize] = useState('landscape_4_3')

  // === Step 6: Schedule ===
  const [scheduleMode, setScheduleMode] = useState('now')
  const [scheduledAt, setScheduledAt] = useState('')

  // === Queue ===
  const [showQueue, setShowQueue] = useState(true)

  // Dynamically restrict aspect ratio based on AI model
  const availableSizes = MODEL_ALLOWED_SIZES[aiImageModel] || aiImageSizes.map(s => s.value)
  useEffect(() => {
    if (!availableSizes.includes(aiImageSize)) {
      setAiImageSize(availableSizes.includes('square') ? 'square' : availableSizes[0])
    }
  }, [aiImageModel, availableSizes, aiImageSize])

  // ─── Queries ───
  const { data: accounts = [] } = useQuery({
    queryKey: ['accounts'],
    queryFn: () => api.get('/accounts').then(r => r.data),
  })

  const { data: fanpages = [] } = useQuery({
    queryKey: ['account-fanpages', selectedAccountId],
    queryFn: () => api.get(`/accounts/${selectedAccountId}/fanpages`).then(r => r.data),
    enabled: !!selectedAccountId,
  })

  const { data: groups = [] } = useQuery({
    queryKey: ['account-groups', selectedAccountId],
    queryFn: () => api.get(`/accounts/${selectedAccountId}/groups`).then(r => r.data),
    enabled: !!selectedAccountId,
  })

  const { data: mediaList = [] } = useQuery({
    queryKey: ['media'],
    queryFn: () => api.get('/media').then(r => r.data),
  })

  const { data: jobs = [] } = useQuery({
    queryKey: ['jobs'],
    queryFn: () => api.get('/jobs').then(r => r.data),
    refetchInterval: 10000,
  })

  // === Read URL params + sessionStorage prefill on mount ===
  useEffect(() => {
    const type = searchParams.get('type')
    const accountId = searchParams.get('accountId')
    const pageId = searchParams.get('pageId')
    const groupId = searchParams.get('groupId')

    if (accountId) {
      setSelectedAccountId(accountId)
      if (type === 'group') {
        setPostType('group')
        if (groupId) setPendingGroupId(groupId)
      } else {
        setPostType('page')
        if (pageId) setPendingPageId(pageId)
      }
      // Clear URL params after reading
      setSearchParams({}, { replace: true })
    }

    // Prefill from research page (sessionStorage)
    try {
      const prefill = sessionStorage.getItem('publish_prefill')
      if (prefill) {
        const data = JSON.parse(prefill)
        if (data.caption) setCaption(data.caption)
        if (data.media_id) {
          setMediaId(data.media_id)
          setMediaMode('selected')
        }
        sessionStorage.removeItem('publish_prefill')
      }
    } catch {}
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // Apply pending page selection when fanpages load
  useEffect(() => {
    if (pendingPageId && fanpages.length > 0) {
      const found = fanpages.find(p => p.id === pendingPageId)
      if (found) setMainPageId(pendingPageId)
      setPendingPageId(null)
    }
  }, [pendingPageId, fanpages])

  // Apply pending group selection when groups load
  useEffect(() => {
    if (pendingGroupId && groups.length > 0) {
      const found = groups.find(g => g.id === pendingGroupId)
      if (found) {
        setGroupSelections(prev => ({
          ...prev,
          [pendingGroupId]: { selected: true, rewrite: false }
        }))
      }
      setPendingGroupId(null)
    }
  }, [pendingGroupId, groups])

  const selectedAccount = accounts.find(a => a.id === selectedAccountId)
  const selectedMedia = mediaList.find(m => m.id === mediaId)
  const mainPage = fanpages.find(p => p.id === mainPageId)
  const ccPagesList = fanpages.filter(p => p.id !== mainPageId) // Pages available for CC (exclude main)

  // ─── Mutations ───
  const publishMutation = useMutation({
    mutationFn: (data) => api.post(`/accounts/${selectedAccountId}/quick-post`, data),
    onSuccess: (res) => {
      const data = res.data
      const directOk = (data.direct_results || []).filter(r => r.status === 'success').length
      const directFail = (data.direct_results || []).filter(r => r.status === 'error')
      const queued = data.job_ids?.length || 0

      if (directOk > 0) toast.success(`Đã đăng thành công ${directOk} bài (API)!`)
      if (queued > 0) toast.success(`${queued} bài đang chờ Agent xử lý`)
      directFail.forEach(f => toast.error(`Lỗi đăng: ${f.error || 'Unknown'}`))
      if (directOk === 0 && queued === 0) toast.error('Không thể đăng bài nào')

      queryClient.invalidateQueries({ queryKey: ['jobs'] })
      queryClient.invalidateQueries({ queryKey: ['content'] })
      setCaption('')
      setHashtags('')
      setMediaId('')
      setMainPageId('')
      setCcEnabled(false)
      setCcPages({})
      setGroupSelections({})
      setIncludeProfile(false)
    },
    onError: (err) => toast.error(err.response?.data?.error || 'Khong the dang bai'),
  })

  const captionAiMutation = useMutation({
    mutationFn: () => {
      const body = { style: aiStyle, language: aiLang, include_cta: true, include_emoji: true }
      if (inputBrief.trim()) {
        body.input_brief = inputBrief.trim()
        if (referenceUrl.trim()) body.reference_url = referenceUrl.trim()
      } else if (caption.trim()) {
        body.reference_caption = caption.trim()
      }
      body.topic = caption || inputBrief || 'noi dung chung'
      return api.post('/ai/caption', body)
    },
    onSuccess: (res) => {
      setCaption(res.data.caption)
      if (res.data.hashtags?.length) setHashtags(res.data.hashtags.join(' '))
      toast.success('AI da viet noi dung' + (res.data.hashtags?.length ? ' + hashtag!' : '!'))
    },
    onError: () => toast.error('Tao noi dung that bai'),
  })

  const hashtagAiMutation = useMutation({
    mutationFn: () => api.post('/ai/hashtags', { caption }),
    onSuccess: (res) => { setHashtags(res.data.hashtags?.join(', ') || ''); toast.success('AI da goi y hashtag!') },
    onError: () => toast.error('Goi y hashtag that bai'),
  })

  const cancelMutation = useMutation({
    mutationFn: (id) => api.post(`/jobs/${id}/cancel`),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ['jobs'] }); toast.success('Da huy') },
  })

  const retryMutation = useMutation({
    mutationFn: (id) => api.post(`/jobs/${id}/retry`),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ['jobs'] }); toast.success('Da them lai') },
  })

  const aiImageMutation = useMutation({
    mutationFn: (data) => api.post('/ai/generate-image', data),
    onSuccess: (res) => {
      setMediaId(res.data.id)
      setMediaMode('selected')
      setShowAiImageGen(false)
      setAiImagePrompt('')
      queryClient.invalidateQueries({ queryKey: ['media'] })
      toast.success('Da tao anh AI!')
    },
    onError: (err) => toast.error(err.response?.data?.error || 'Tao anh that bai'),
  })

  const aiPromptGenMutation = useMutation({
    mutationFn: (captionText) => api.post('/ai/generate', {
      function_name: 'caption_gen',
      messages: [{
        role: 'user',
        content: `You are an expert at writing image generation prompts for AI models like Flux and Stable Diffusion.

Given this Facebook post content, create a detailed image prompt in English that would produce a visually appealing, eye-catching image to accompany the post.

Post content:
"${captionText}"

Requirements:
- Write the prompt in English
- Be specific about style, lighting, composition, colors
- Keep it under 200 characters
- Focus on visual elements that match the post's theme
- Make it suitable for social media

Return ONLY the image prompt, nothing else.`
      }]
    }),
    onSuccess: (res) => {
      const prompt = res.data.text?.trim().replace(/^["']|["']$/g, '') || ''
      if (prompt) {
        setAiImagePrompt(prompt)
        toast.success('Da tao prompt anh!')
      }
    },
    onError: () => toast.error('Khong the tao prompt anh'),
  })

  const handleGenerateImage = () => {
    if (!aiImagePrompt.trim()) return
    aiImageMutation.mutate({
      prompt: aiImagePrompt,
      model: aiImageModel,
      image_size: aiImageSize,
    })
  }

  // ─── Handlers ───
  const handleAccountChange = (id) => {
    setSelectedAccountId(id)
    setMainPageId('')
    setCcEnabled(false)
    setCcPages({})
    setGroupSelections({})
    setIncludeProfile(false)
  }

  const handlePostTypeChange = (type) => {
    setPostType(type)
    setMainPageId('')
    setCcEnabled(false)
    setCcPages({})
    setGroupSelections({})
  }

  const toggleCcPage = (pageId) => {
    setCcPages(prev => ({
      ...prev,
      [pageId]: {
        selected: !prev[pageId]?.selected,
        rewrite: prev[pageId]?.rewrite || false,
      }
    }))
  }

  const toggleCcRewrite = (pageId) => {
    setCcPages(prev => ({
      ...prev,
      [pageId]: { ...prev[pageId], rewrite: !prev[pageId]?.rewrite }
    }))
  }

  const toggleGroup = (groupId) => {
    setGroupSelections(prev => ({
      ...prev,
      [groupId]: {
        selected: !prev[groupId]?.selected,
        rewrite: prev[groupId]?.rewrite || false,
      }
    }))
  }

  const toggleGroupRewrite = (groupId) => {
    setGroupSelections(prev => ({
      ...prev,
      [groupId]: { ...prev[groupId], rewrite: !prev[groupId]?.rewrite }
    }))
  }

  const selectAllGroups = () => {
    const allSelected = groups.every(g => groupSelections[g.id]?.selected)
    if (allSelected) {
      setGroupSelections({})
    } else {
      const newSel = {}
      groups.forEach(g => { newSel[g.id] = { selected: true, rewrite: groupSelections[g.id]?.rewrite || false } })
      setGroupSelections(newSel)
    }
  }

  const selectAllCcPages = () => {
    const allSelected = ccPagesList.every(p => ccPages[p.id]?.selected)
    if (allSelected) {
      setCcPages({})
    } else {
      const newSel = {}
      ccPagesList.forEach(p => { newSel[p.id] = { selected: true, rewrite: ccPages[p.id]?.rewrite || false } })
      setCcPages(newSel)
    }
  }

  // Build targets for submission
  const buildTargets = () => {
    const targets = []

    if (postType === 'page') {
      if (mainPageId) {
        targets.push({ type: 'page', id: mainPageId })
      }
      if (ccEnabled) {
        Object.entries(ccPages).forEach(([id, cfg]) => {
          if (cfg.selected) targets.push({ type: 'page', id, rewrite: cfg.rewrite || false })
        })
      }
    } else {
      Object.entries(groupSelections).forEach(([id, cfg]) => {
        if (cfg.selected) targets.push({ type: 'group', id, rewrite: cfg.rewrite || false })
      })
    }

    if (includeProfile) {
      targets.push({ type: 'profile', id: selectedAccountId })
    }

    return targets
  }

  const targetCount = buildTargets().length

  const handlePublish = () => {
    if (!caption) return toast.error('Cần có nội dung bài viết')
    if (!selectedAccountId) return toast.error('Chọn tài khoản')

    const targets = buildTargets()
    if (targets.length === 0) return toast.error('Chọn nơi đăng')

    // "Chọn ảnh cụ thể" — bắt buộc phải chọn ảnh
    if (mediaMode === 'selected' && !mediaId) {
      return toast.error('Bạn chọn chế độ "Chọn ảnh cụ thể" — vui lòng chọn ảnh trước khi đăng')
    }

    // "Random" + local — phải có ít nhất 1 file
    if (mediaMode === 'random' && randomSource === 'local' && localMediaFiles.length === 0) {
      return toast.error('Vui lòng chọn ảnh từ máy tính để random')
    }

    const hashtagsArr = hashtags.split(/[,\s]+/).map(t => t.replace(/^#/, '').trim()).filter(Boolean)

    // Random + local: upload files first, then publish
    if (mediaMode === 'random' && randomSource === 'local' && localMediaFiles.length > 0) {
      // Upload local files to media library first
      const uploadPromises = localMediaFiles.map(async (file) => {
        const formData = new FormData()
        formData.append('file', file)
        const res = await api.post('/media/upload', formData, { headers: { 'Content-Type': 'multipart/form-data' } })
        return res.data?.id || res.data?.media?.id
      })
      toast.promise(
        Promise.all(uploadPromises).then(mediaIds => {
          const validIds = mediaIds.filter(Boolean)
          publishMutation.mutate({
            targets,
            caption,
            hashtags: hashtagsArr,
            media_mode: 'random',
            random_media_ids: validIds,
            scheduled_at: scheduleMode === 'scheduled' && scheduledAt ? scheduledAt : undefined,
          })
        }),
        { loading: `Đang upload ${localMediaFiles.length} ảnh...`, success: 'Upload xong, đang tạo bài...', error: 'Lỗi upload ảnh' }
      )
      return
    }

    publishMutation.mutate({
      targets,
      caption,
      hashtags: hashtagsArr,
      media_id: mediaMode === 'selected' && mediaId ? mediaId : undefined,
      media_mode: mediaMode,
      random_source: mediaMode === 'random' ? randomSource : undefined,
      scheduled_at: scheduleMode === 'scheduled' && scheduledAt ? scheduledAt : undefined,
    })
  }

  // Recent jobs
  const recentJobs = useMemo(() =>
    jobs.filter(j => ['post_page', 'post_page_graph', 'post_group', 'post_profile'].includes(j.type || j.job_type))
      .slice(0, 20),
    [jobs]
  )

  return (
    <div className="max-w-5xl mx-auto">
      <h1 className="text-2xl font-bold text-app-primary mb-5">Dang bai</h1>

      {/* ══════ SECTION 1: Account + Post Type ══════ */}
      <div className="bg-app-surface rounded shadow p-4 mb-4">
        <div className="flex flex-col sm:flex-row gap-4">
          {/* Account */}
          <div className="flex-1">
            <label className="block text-xs font-medium text-app-muted mb-1.5">Tài khoản</label>
            <select
              value={selectedAccountId}
              onChange={e => handleAccountChange(e.target.value)}
              disabled={!!searchParams.get('accountId')}
              className="w-full border rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-blue-500 disabled:opacity-60 disabled:bg-app-base disabled:cursor-not-allowed"
            >
              <option value="">-- Chọn tài khoản --</option>
              {accounts.map(a => (
                <option key={a.id} value={a.id}>
                  {a.username || a.fb_user_id} {a.status !== 'healthy' ? `(${a.status})` : ''}
                </option>
              ))}
            </select>
          </div>

          {/* Post Type Tabs */}
          {selectedAccountId && (
            <div className="flex-1">
              <label className="block text-xs font-medium text-app-muted mb-1.5">Loai bai dang</label>
              <div className="flex rounded-lg border overflow-hidden">
                <button
                  onClick={() => handlePostTypeChange('page')}
                  className={`flex-1 flex items-center justify-center gap-2 px-4 py-2 text-sm font-medium transition-colors ${
                    postType === 'page'
                      ? 'bg-info text-white'
                      : 'bg-app-surface text-app-muted hover:bg-app-base'
                  }`}
                >
                  <FileText size={16} /> Fanpage
                </button>
                <button
                  onClick={() => handlePostTypeChange('group')}
                  className={`flex-1 flex items-center justify-center gap-2 px-4 py-2 text-sm font-medium transition-colors ${
                    postType === 'group'
                      ? 'bg-info text-white'
                      : 'bg-app-surface text-app-muted hover:bg-app-base'
                  }`}
                >
                  <Users size={16} /> Nhom
                </button>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* ══════ SECTION 2: Target Selection ══════ */}
      {selectedAccountId && (
        <div className="bg-app-surface rounded shadow p-4 mb-4">
          {postType === 'page' ? (
            /* ─── Fanpage Mode ─── */
            <div>
              {/* Main Page */}
              <div className="mb-4">
                <label className="block text-xs font-medium text-app-muted mb-1.5">Trang chinh</label>
                {fanpages.length > 0 ? (
                  <select
                    value={mainPageId}
                    onChange={e => setMainPageId(e.target.value)}
                    className="w-full border rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-blue-500"
                  >
                    <option value="">-- Chon trang --</option>
                    {fanpages.map(p => (
                      <option key={p.id} value={p.id}>
                        {p.name || p.fb_page_id} [{p.posting_method === 'access_token' ? 'API' : p.posting_method === 'cookie' ? 'Cookie' : 'Auto'}]
                      </option>
                    ))}
                  </select>
                ) : (
                  <p className="text-sm text-app-dim py-2">Chua co fanpage. Hay quet tai khoan truoc.</p>
                )}
                {mainPage && (
                  <div className="mt-1.5 flex items-center gap-2">
                    <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${
                      mainPage.posting_method === 'access_token' ? 'bg-green-100 text-hermes' :
                      mainPage.posting_method === 'cookie' ? 'bg-orange-100 text-orange-700' :
                      'bg-app-elevated text-app-muted'
                    }`}>
                      {mainPage.posting_method === 'access_token' ? 'API Token' : mainPage.posting_method === 'cookie' ? 'Cookie' : 'Auto'}
                    </span>
                    <span className="text-xs text-app-dim">
                      {mainPage.posting_method === 'access_token' ? '⚡ Đăng trực tiếp qua API (tức thì)' : mainPage.posting_method === 'cookie' ? '🕐 Đăng qua Agent (chờ xử lý)' : 'Tự động chọn phương thức'}
                    </span>
                  </div>
                )}
              </div>

              {/* CC to other pages */}
              {mainPageId && ccPagesList.length > 0 && (
                <div>
                  <div className="flex items-center justify-between mb-2">
                    <label className="flex items-center gap-2 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={ccEnabled}
                        onChange={() => setCcEnabled(!ccEnabled)}
                        className="rounded text-info"
                      />
                      <span className="text-sm font-medium text-app-primary">CC qua trang khac</span>
                    </label>
                    {ccEnabled && (
                      <button onClick={selectAllCcPages} className="text-xs text-info hover:text-blue-800">
                        {ccPagesList.every(p => ccPages[p.id]?.selected) ? 'Bo chon' : 'Chon tat ca'}
                      </button>
                    )}
                  </div>

                  {ccEnabled && (
                    <div className="border rounded-lg divide-y max-h-48 overflow-y-auto">
                      {ccPagesList.map(p => (
                        <div key={p.id} className="flex items-center gap-3 px-3 py-2 hover:bg-app-base">
                          <input
                            type="checkbox"
                            checked={ccPages[p.id]?.selected || false}
                            onChange={() => toggleCcPage(p.id)}
                            className="rounded text-info"
                          />
                          <span className="flex-1 text-sm truncate">{p.name || p.fb_page_id}</span>
                          <span className={`text-[10px] px-1.5 py-0.5 rounded-full shrink-0 ${
                            p.posting_method === 'access_token' ? 'bg-green-100 text-hermes' :
                            p.posting_method === 'cookie' ? 'bg-orange-100 text-orange-600' :
                            'bg-app-elevated text-app-muted'
                          }`}>
                            {p.posting_method === 'access_token' ? 'API' : p.posting_method === 'cookie' ? 'Cookie' : 'Auto'}
                          </span>
                          <a href={p.url || `https://www.facebook.com/${p.fb_page_id}`} target="_blank" rel="noopener noreferrer"
                            onClick={e => e.stopPropagation()} className="text-app-dim hover:text-info shrink-0" title="Xem trang">
                            <ExternalLink size={12} />
                          </a>
                          {ccPages[p.id]?.selected && (
                            <button
                              onClick={() => toggleCcRewrite(p.id)}
                              className={`flex items-center gap-1 text-xs px-2 py-0.5 rounded-full transition-colors ${
                                ccPages[p.id]?.rewrite
                                  ? 'bg-purple-100 text-purple-700'
                                  : 'bg-app-elevated text-app-muted hover:bg-app-hover'
                              }`}
                            >
                              <RefreshCw size={10} />
                              {ccPages[p.id]?.rewrite ? 'AI viet lai' : 'Giu nguyen'}
                            </button>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          ) : (
            /* ─── Group Mode ─── */
            <div>
              <div className="flex items-center justify-between mb-2">
                <label className="block text-xs font-medium text-app-muted">Chon nhom ({groups.length})</label>
                {groups.length > 0 && (
                  <button onClick={selectAllGroups} className="text-xs text-info hover:text-blue-800">
                    {groups.every(g => groupSelections[g.id]?.selected) ? 'Bo chon' : 'Chon tat ca'}
                  </button>
                )}
              </div>

              {groups.length > 0 ? (
                <div className="border rounded-lg divide-y max-h-56 overflow-y-auto">
                  {groups.map(g => (
                    <div key={g.id} className="flex items-center gap-3 px-3 py-2 hover:bg-app-base">
                      <input
                        type="checkbox"
                        checked={groupSelections[g.id]?.selected || false}
                        onChange={() => toggleGroup(g.id)}
                        className="rounded text-info"
                      />
                      <span className="flex-1 text-sm truncate">{g.name || g.fb_group_id}</span>
                      <a href={g.url || `https://www.facebook.com/groups/${g.fb_group_id}`} target="_blank" rel="noopener noreferrer"
                        onClick={e => e.stopPropagation()} className="text-app-dim hover:text-info shrink-0" title="Xem nhom">
                        <ExternalLink size={12} />
                      </a>
                      {g.member_count && (
                        <span className="text-xs text-app-dim">{g.member_count.toLocaleString()}</span>
                      )}
                      {groupSelections[g.id]?.selected && (
                        <button
                          onClick={() => toggleGroupRewrite(g.id)}
                          className={`flex items-center gap-1 text-xs px-2 py-0.5 rounded-full transition-colors ${
                            groupSelections[g.id]?.rewrite
                              ? 'bg-purple-100 text-purple-700'
                              : 'bg-app-elevated text-app-muted hover:bg-app-hover'
                          }`}
                        >
                          <RefreshCw size={10} />
                          {groupSelections[g.id]?.rewrite ? 'AI viet lai' : 'Giu nguyen'}
                        </button>
                      )}
                    </div>
                  ))}
                </div>
              ) : (
                <p className="text-sm text-app-dim py-2">Chua co nhom. Hay quet tai khoan truoc.</p>
              )}
            </div>
          )}

          {/* Profile toggle - available in both modes */}
          <div className="mt-3 pt-3 border-t">
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={includeProfile}
                onChange={() => setIncludeProfile(!includeProfile)}
                className="rounded text-info"
              />
              <span className="text-sm text-app-muted">Dang len trang ca nhan</span>
              <span className="text-xs text-app-dim">({selectedAccount?.username || 'Profile'})</span>
            </label>
          </div>
        </div>
      )}

      {/* ══════ SECTION 3: Content + Media (2 columns) ══════ */}
      <div className="grid grid-cols-1 lg:grid-cols-5 gap-4 mb-4">
        {/* Content - 3 cols */}
        <div className="lg:col-span-3 space-y-4">
          {/* Input Brief — thong tin dau vao */}
          <div className="bg-app-surface rounded shadow p-4">
            <div className="flex items-center gap-2 mb-2">
              <FileText size={14} className="text-purple-500" />
              <h3 className="font-semibold text-app-primary text-sm">Thong tin dau vao</h3>
            </div>
            <p className="text-xs text-app-muted mb-2">Nhap y tuong, brief, thong tin san pham hoac dan link. AI se viet bai chuyen nghiep tu day.</p>
            <textarea
              value={inputBrief}
              onChange={e => setInputBrief(e.target.value)}
              rows={3}
              placeholder="VD: Gioi thieu dich vu hosting gia re, SSD NVMe, uptime 99.9%, ho tro 24/7..."
              className="w-full border rounded-lg px-3 py-2 resize-none text-sm bg-purple-50/50 focus:ring-2 focus:ring-purple-500 focus:border-purple-500 placeholder:text-app-dim"
            />
            <div className="flex items-center gap-2 mt-2">
              <input
                type="url"
                value={referenceUrl}
                onChange={e => setReferenceUrl(e.target.value)}
                placeholder="Link tham khao (tuy chon)"
                className="flex-1 border rounded-lg px-3 py-1.5 text-xs focus:ring-2 focus:ring-purple-500 focus:border-purple-500"
              />
            </div>
            <button
              onClick={() => captionAiMutation.mutate()}
              disabled={captionAiMutation.isPending || (!inputBrief.trim() && !caption.trim())}
              className="mt-3 w-full flex items-center justify-center gap-2 px-4 py-2.5 rounded bg-purple-600 text-white text-sm font-medium hover:bg-purple-700 disabled:bg-app-hover disabled:text-app-muted transition-colors"
            >
              {captionAiMutation.isPending ? <Loader size={14} className="animate-spin" /> : <Sparkles size={14} />}
              {captionAiMutation.isPending ? 'Dang viet...' : 'AI Viet bai'}
            </button>
          </div>

          {/* Caption */}
          <div className="bg-app-surface rounded shadow p-4">
            <div className="flex items-center justify-between mb-2">
              <h3 className="font-semibold text-app-primary text-sm">Noi dung bai viet</h3>
              <div className="flex items-center gap-2">
                <span className="text-xs text-app-dim">{caption.length} ky tu</span>
                {caption.trim() && (
                  <button
                    onClick={() => captionAiMutation.mutate()}
                    disabled={captionAiMutation.isPending}
                    className="flex items-center gap-1 text-xs bg-purple-50 text-purple-600 px-2.5 py-1 rounded-lg hover:bg-purple-100"
                  >
                    {captionAiMutation.isPending ? <Loader size={12} className="animate-spin" /> : <Sparkles size={12} />}
                    Viet lai
                  </button>
                )}
              </div>
            </div>
            <textarea
              value={caption}
              onChange={e => setCaption(e.target.value)}
              rows={5}
              placeholder="Noi dung se duoc AI gen tu thong tin dau vao, hoac nhap truc tiep..."
              className="w-full border rounded-lg px-3 py-2 resize-none text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
            />
            {/* AI Style */}
            <div className="flex flex-wrap gap-1.5 mt-2">
              {stylePresets.map(s => (
                <button
                  key={s.value}
                  onClick={() => setAiStyle(s.value)}
                  className={`px-2 py-0.5 rounded text-xs transition-colors ${
                    aiStyle === s.value ? 'bg-purple-600 text-white' : 'bg-app-elevated text-app-muted hover:bg-app-hover'
                  }`}
                >
                  {s.emoji} {s.label}
                </button>
              ))}
              <button
                onClick={() => setAiLang(l => l === 'vi' ? 'en' : 'vi')}
                className="px-2 py-0.5 rounded text-xs bg-app-elevated text-app-muted hover:bg-app-hover"
              >
                {aiLang === 'vi' ? 'VI' : 'EN'}
              </button>
            </div>
          </div>

          {/* Hashtags */}
          <HashtagSection
            value={hashtags}
            onChange={setHashtags}
            onAiGenerate={() => hashtagAiMutation.mutate()}
            isGenerating={hashtagAiMutation.isPending}
            compact
          />
        </div>

        {/* Media - 2 cols */}
        <div className="lg:col-span-2">
          <div className="bg-app-surface rounded shadow p-4">
            <h3 className="font-semibold text-app-primary text-sm mb-3">Anh / Video</h3>

            {/* Media Mode */}
            <div className="space-y-2 mb-3">
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="radio"
                  name="mediaMode"
                  checked={mediaMode === 'selected'}
                  onChange={() => setMediaMode('selected')}
                  className="text-info"
                />
                <Image size={14} className="text-app-muted" />
                <span className="text-sm">Chon anh cu the</span>
              </label>
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="radio"
                  name="mediaMode"
                  checked={mediaMode === 'random'}
                  onChange={() => setMediaMode('random')}
                  className="text-info"
                />
                <Shuffle size={14} className="text-app-muted" />
                <span className="text-sm">Random tu thu vien</span>
              </label>
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="radio"
                  name="mediaMode"
                  checked={mediaMode === 'none'}
                  onChange={() => { setMediaMode('none'); setMediaId('') }}
                  className="text-info"
                />
                <ImageOff size={14} className="text-app-muted" />
                <span className="text-sm">Khong dung anh</span>
              </label>
            </div>

            {/* Media Picker (only if mode = selected) */}
            {mediaMode === 'selected' && (
              <>
                {selectedMedia ? (
                  <div className="flex items-center gap-3 p-2 bg-app-base rounded-lg mb-3">
                    <div className="w-12 h-12 bg-app-hover rounded overflow-hidden flex items-center justify-center shrink-0">
                      {(selectedMedia.thumbnail_url || selectedMedia.url || selectedMedia.original_path) ? (
                        <img src={selectedMedia.thumbnail_url || selectedMedia.url || selectedMedia.original_path} alt="" className="w-full h-full object-cover" />
                      ) : <Film size={20} className="text-app-dim" />}
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium truncate">{selectedMedia.title || selectedMedia.original_filename}</p>
                    </div>
                    <button onClick={() => setMediaId('')} className="text-app-dim hover:text-app-muted"><X size={16} /></button>
                  </div>
                ) : null}
                
                <div className="space-y-2">
                  <div className="flex flex-col gap-2">
                    <input
                      type="text"
                      placeholder="Tìm ảnh..."
                      value={mediaSearch}
                      onChange={e => setMediaSearch(e.target.value)}
                      className="w-full border border-app-border rounded px-2 py-1 text-xs outline-none focus:border-blue-500 bg-app-base"
                    />
                    <div className="flex bg-app-elevated p-0.5 rounded w-fit">
                      <button onClick={() => setMediaFilter('all')} className={`text-[10px] px-2 py-1 rounded transition-colors ${mediaFilter === 'all' ? 'bg-app-surface shadow text-app-primary' : 'text-app-muted hover:text-app-primary'}`}>Tất cả</button>
                      <button onClick={() => setMediaFilter('ai')} className={`text-[10px] px-2 py-1 rounded transition-colors ${mediaFilter === 'ai' ? 'bg-app-surface shadow text-app-primary' : 'text-app-muted hover:text-app-primary'}`}>AI</button>
                      <button onClick={() => setMediaFilter('uploaded')} className={`text-[10px] px-2 py-1 rounded transition-colors ${mediaFilter === 'uploaded' ? 'bg-app-surface shadow text-app-primary' : 'text-app-muted hover:text-app-primary'}`}>Tải lên</button>
                    </div>
                  </div>

                  <div className="grid grid-cols-4 gap-1.5 max-h-40 overflow-y-auto">
                    {mediaList
                      .filter(m => mediaFilter === 'all' || (mediaFilter === 'ai' && m.source_type === 'generated') || (mediaFilter === 'uploaded' && m.source_type !== 'generated'))
                      .filter(m => !mediaSearch || m.title?.toLowerCase().includes(mediaSearch.toLowerCase()) || m.original_filename?.toLowerCase().includes(mediaSearch.toLowerCase()))
                      .slice(0, 32).map(m => (
                        <button
                          key={m.id}
                          onClick={() => setMediaId(m.id)}
                          className={`aspect-square bg-app-elevated rounded overflow-hidden hover:ring-2 hover:ring-blue-500 ${mediaId === m.id ? 'ring-2 ring-blue-500' : ''}`}
                        >
                          {(m.thumbnail_url || m.url || m.original_path) ? (
                            <img src={m.thumbnail_url || m.url || m.original_path} alt="" className="w-full h-full object-cover" />
                          ) : (
                            <div className="w-full h-full flex items-center justify-center">
                              {m.type === 'video' ? <Film size={16} className="text-app-dim" /> : <Image size={16} className="text-app-dim" />}
                            </div>
                          )}
                        </button>
                      ))}
                      {mediaList.length === 0 && <p className="col-span-4 text-xs text-app-dim text-center py-3">Chưa có media</p>}
                  </div>
                </div>
              </>
            )}

            {mediaMode === 'random' && (
              <div className="space-y-3">
                {/* Random source selection */}
                <div className="flex gap-2">
                  <button
                    onClick={() => setRandomSource('library')}
                    className={`flex-1 flex items-center justify-center gap-2 px-3 py-2 rounded-lg text-xs font-medium border transition-colors ${
                      randomSource === 'library' ? 'bg-purple-50 border-purple-300 text-purple-700' : 'bg-app-base border-app-border text-app-muted hover:border-app-border'
                    }`}
                  >
                    <Image size={14} />
                    Từ thư viện
                  </button>
                  <button
                    onClick={() => setRandomSource('local')}
                    className={`flex-1 flex items-center justify-center gap-2 px-3 py-2 rounded-lg text-xs font-medium border transition-colors ${
                      randomSource === 'local' ? 'bg-purple-50 border-purple-300 text-purple-700' : 'bg-app-base border-app-border text-app-muted hover:border-app-border'
                    }`}
                  >
                    <Plus size={14} />
                    Từ thư mục máy tính
                  </button>
                </div>

                {randomSource === 'library' && (
                  <div className="bg-purple-50 rounded-lg p-3 text-xs text-purple-600">
                    <Shuffle size={14} className="inline mr-1" />
                    Hệ thống sẽ chọn ngẫu nhiên 1 ảnh/video từ thư viện cho mỗi bài đăng
                  </div>
                )}

                {randomSource === 'local' && (
                  <div className="space-y-2">
                    <div className="bg-purple-50 rounded-lg p-3 text-xs text-purple-600">
                      <Shuffle size={14} className="inline mr-1" />
                      Chọn nhiều ảnh từ máy tính — hệ thống sẽ random 1 ảnh cho mỗi bài đăng
                    </div>
                    <label className="flex items-center justify-center gap-2 px-4 py-3 border-2 border-dashed border-purple-300 rounded-lg cursor-pointer hover:bg-purple-50 transition-colors">
                      <Plus size={16} className="text-purple-500" />
                      <span className="text-sm text-purple-600 font-medium">Chọn ảnh từ máy tính</span>
                      <input
                        type="file"
                        multiple
                        accept="image/*,video/*"
                        className="hidden"
                        onChange={(e) => {
                          const files = Array.from(e.target.files || [])
                          if (files.length > 0) {
                            setLocalMediaFiles(prev => [...prev, ...files])
                            toast.success(`Đã thêm ${files.length} file`)
                          }
                        }}
                      />
                    </label>
                    {localMediaFiles.length > 0 && (
                      <div className="space-y-1">
                        <div className="flex items-center justify-between">
                          <span className="text-xs text-app-muted">{localMediaFiles.length} file đã chọn</span>
                          <button onClick={() => setLocalMediaFiles([])} className="text-xs text-red-500 hover:text-red-600">Xóa hết</button>
                        </div>
                        <div className="grid grid-cols-5 gap-1.5 max-h-32 overflow-y-auto">
                          {localMediaFiles.map((f, i) => (
                            <div key={i} className="relative aspect-square bg-app-elevated rounded overflow-hidden group">
                              <img src={URL.createObjectURL(f)} alt="" className="w-full h-full object-cover" />
                              <button
                                onClick={() => setLocalMediaFiles(prev => prev.filter((_, idx) => idx !== i))}
                                className="absolute top-0.5 right-0.5 bg-black/50 text-white rounded-full p-0.5 opacity-0 group-hover:opacity-100 transition-opacity"
                              >
                                <X size={10} />
                              </button>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}

            {/* AI Image Generation */}
            <div className="mt-3 pt-3 border-t">
              <button
                onClick={() => setShowAiImageGen(!showAiImageGen)}
                className="flex items-center gap-2 text-sm text-yellow-600 hover:text-yellow-700 font-medium"
              >
                <Wand2 size={14} />
                Tao anh bang AI
                {showAiImageGen ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
              </button>

              {showAiImageGen && (
                <div className="mt-3 space-y-3 bg-yellow-50 rounded-lg p-3">
                  <div>
                    <div className="flex items-center justify-between mb-1">
                      <span className="text-xs font-medium text-app-muted">Prompt anh</span>
                      <button
                        onClick={() => {
                          if (!caption.trim()) {
                            toast.error('Nhap noi dung bai viet truoc de AI goi y prompt anh')
                            return
                          }
                          aiPromptGenMutation.mutate(caption)
                        }}
                        disabled={aiPromptGenMutation.isPending || !caption.trim()}
                        className="flex items-center gap-1 text-xs bg-blue-50 text-info px-2 py-0.5 rounded hover:bg-blue-100 disabled:opacity-50"
                      >
                        {aiPromptGenMutation.isPending ? (
                          <><Loader2 size={10} className="animate-spin" /> Dang tao...</>
                        ) : (
                          <><Sparkles size={10} /> AI goi y tu noi dung</>
                        )}
                      </button>
                    </div>
                    <textarea
                      value={aiImagePrompt}
                      onChange={e => setAiImagePrompt(e.target.value)}
                      placeholder="Mo ta anh ban muon tao, hoac bam 'AI goi y' de tu dong tao tu noi dung bai viet"
                      rows={2}
                      className="w-full border rounded-lg px-3 py-2 text-sm resize-none focus:ring-2 focus:ring-yellow-500 focus:border-transparent"
                    />
                  </div>
                  <div className="flex gap-2">
                    <select
                      value={aiImageModel}
                      onChange={e => setAiImageModel(e.target.value)}
                      className="flex-1 border rounded-lg px-2 py-1.5 text-xs"
                    >
                      <option value="fal-ai/flux/schnell">Flux Schnell (nhanh)</option>
                      <option value="fal-ai/flux/dev">Flux Dev</option>
                      <option value="fal-ai/flux-pro/v1.1">Flux Pro 1.1</option>
                      <option value="fal-ai/flux.2/dev">Flux 2 Dev (mới)</option>
                      <option value="fal-ai/nano-banana-2">Nano 2 (siêu nhanh)</option>
                      <option value="fal-ai/nano-banana-pro">Nano Pro (Gemini)</option>
                      <option value="fal-ai/recraft-v3">Recraft V3</option>
                      <option value="fal-ai/recraft-v4">Recraft V4 (mới)</option>
                      <option value="fal-ai/ideogram/v3">Ideogram V3</option>
                      <option value="fal-ai/qwen-image-max">Qwen Image Max</option>
                    </select>
                    <select
                      value={aiImageSize}
                      onChange={e => setAiImageSize(e.target.value)}
                      className="border rounded-lg px-2 py-1.5 text-xs"
                    >
                      {aiImageSizes.filter(s => availableSizes.includes(s.value)).map(s => (
                        <option key={s.value} value={s.value}>{s.label}</option>
                      ))}
                    </select>
                  </div>
                  <button
                    onClick={handleGenerateImage}
                    disabled={aiImageMutation.isPending || !aiImagePrompt.trim()}
                    className="flex items-center gap-2 bg-yellow-500 text-white px-4 py-2 rounded-lg hover:bg-yellow-600 disabled:opacity-50 text-sm font-medium w-full justify-center"
                  >
                    {aiImageMutation.isPending ? (
                      <><Loader2 size={14} className="animate-spin" /> Dang tao anh...</>
                    ) : (
                      <><Wand2 size={14} /> Tao anh</>
                    )}
                  </button>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* ══════ SECTION 4: Schedule + Submit ══════ */}
      <div className="bg-app-surface rounded shadow p-4 mb-4">
        <div className="flex flex-col sm:flex-row items-start sm:items-center gap-4">
          {/* Schedule */}
          <div className="flex items-center gap-4 flex-1">
            <label className="flex items-center gap-2 cursor-pointer">
              <input type="radio" name="schedule" checked={scheduleMode === 'now'} onChange={() => setScheduleMode('now')} className="text-info" />
              <Zap size={14} className="text-yellow-500" />
              <span className="text-sm">Dang ngay</span>
            </label>
            <label className="flex items-center gap-2 cursor-pointer">
              <input type="radio" name="schedule" checked={scheduleMode === 'scheduled'} onChange={() => setScheduleMode('scheduled')} className="text-info" />
              <CalendarClock size={14} className="text-info" />
              <span className="text-sm">Hen gio</span>
            </label>
            {scheduleMode === 'scheduled' && (
              <input
                type="datetime-local"
                value={scheduledAt}
                onChange={e => setScheduledAt(e.target.value)}
                className="border rounded-lg px-3 py-1.5 text-sm"
              />
            )}
          </div>

          {/* Submit Button */}
          <button
            onClick={handlePublish}
            disabled={publishMutation.isPending || targetCount === 0}
            className="flex items-center justify-center gap-2 bg-info text-white px-6 py-2.5 rounded hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed font-medium text-sm  shadow-blue-600/20 whitespace-nowrap"
          >
            {publishMutation.isPending ? (
              <><Loader size={16} className="animate-spin" /> Dang tao...</>
            ) : (
              <><Send size={16} /> Dang bai{targetCount > 0 ? ` (${targetCount})` : ''}</>
            )}
          </button>
        </div>

        {/* Targets summary */}
        {targetCount > 0 && (
          <div className="mt-3 pt-3 border-t">
            <div className="flex flex-wrap gap-1.5">
              {buildTargets().map((t, i) => (
                <span key={i} className="inline-flex items-center gap-1 text-xs bg-blue-50 text-info px-2 py-1 rounded-full border border-blue-100">
                  {t.type === 'page' ? '📄' : t.type === 'group' ? '👥' : '👤'}
                  {t.type === 'page'
                    ? fanpages.find(p => p.id === t.id)?.name || t.id
                    : t.type === 'group'
                      ? groups.find(g => g.id === t.id)?.name || t.id
                      : selectedAccount?.username || 'Profile'
                  }
                  {t.rewrite && <RefreshCw size={10} className="text-purple-500" />}
                </span>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* ══════ SECTION 5: Queue ══════ */}
      <div>
        <button
          onClick={() => setShowQueue(!showQueue)}
          className="flex items-center gap-2 text-app-muted hover:text-app-primary mb-3"
        >
          {showQueue ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
          <span className="font-semibold text-sm">Hang doi ({recentJobs.length})</span>
        </button>

        {showQueue && (
          <div className="bg-app-surface rounded shadow overflow-hidden">
            <table className="w-full">
              <thead className="bg-app-base">
                <tr>
                  <th className="px-3 py-2 text-left text-xs font-medium text-app-muted">Loai</th>
                  <th className="px-3 py-2 text-left text-xs font-medium text-app-muted">Noi dang</th>
                  <th className="px-3 py-2 text-left text-xs font-medium text-app-muted">Lich</th>
                  <th className="px-3 py-2 text-left text-xs font-medium text-app-muted">Trang thai</th>
                  <th className="px-3 py-2 text-center text-xs font-medium text-app-muted">Link</th>
                  <th className="px-3 py-2 text-right text-xs font-medium text-app-muted">Thao tac</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {recentJobs.map(job => {
                  const config = statusConfig[job.status] || statusConfig.pending
                  const Icon = config.icon
                  return (
                    <tr key={job.id} className="hover:bg-app-base">
                      <td className="px-3 py-2">
                        <span className="text-xs bg-app-elevated text-app-muted px-1.5 py-0.5 rounded">
                          {typeLabels[job.type || job.job_type] || job.type}
                        </span>
                      </td>
                      <td className="px-3 py-2 text-xs text-app-muted truncate max-w-[200px]">
                        {job.target_name || job.payload?.target_id || '-'}
                      </td>
                      <td className="px-3 py-2 text-xs text-app-muted">
                        {job.scheduled_at ? new Date(job.scheduled_at).toLocaleString('vi') : '-'}
                      </td>
                      <td className="px-3 py-2">
                        <span className={`inline-flex items-center gap-1 text-xs px-1.5 py-0.5 rounded-full ${config.cls}`}>
                          <Icon size={10} className={job.status === 'running' || job.status === 'claimed' ? 'animate-spin' : ''} />
                          {config.label}
                        </span>
                      </td>
                      <td className="px-3 py-2 text-center">
                        {job.status === 'done' && job.result?.post_url ? (
                          <a
                            href={job.result.post_url}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="inline-flex items-center gap-1 text-xs text-info hover:text-blue-800"
                            title="Xem bai dang tren Facebook"
                          >
                            <ExternalLink size={12} />
                          </a>
                        ) : (
                          <span className="text-app-dim">-</span>
                        )}
                      </td>
                      <td className="px-3 py-2 text-right">
                        {(job.status === 'pending' || job.status === 'claimed' || job.status === 'running') && (
                          <button onClick={() => cancelMutation.mutate(job.id)} className="text-app-dim hover:text-red-500 text-xs">
                            <XCircle size={14} />
                          </button>
                        )}
                        {job.status === 'failed' && (
                          <button onClick={() => retryMutation.mutate(job.id)} className="text-app-dim hover:text-info text-xs">
                            <RotateCcw size={14} />
                          </button>
                        )}
                      </td>
                    </tr>
                  )
                })}
                {recentJobs.length === 0 && (
                  <tr>
                    <td colSpan={6} className="px-3 py-8 text-center text-sm text-app-dim">
                      Chua co bai dang nao trong hang doi
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* ══════ SECTION 6: Published Posts History ══════ */}
      <PublishHistory />
    </div>
  )
}

// ==========================================
// Published Posts History Component
// ==========================================
function PublishHistory() {
  const [show, setShow] = useState(true)
  const { data: historyData = { data: [] }, isLoading } = useQuery({
    queryKey: ['publish-history'],
    queryFn: () => api.get('/content/publish-history?limit=30').then(r => r.data),
    refetchInterval: 30000,
  })

  const posts = historyData.data || []

  return (
    <div className="mt-4">
      <button
        onClick={() => setShow(!show)}
        className="flex items-center gap-2 text-app-muted hover:text-app-primary mb-3"
      >
        {show ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
        <span className="font-semibold text-sm">Bai da dang ({posts.length})</span>
      </button>

      {show && (
        <div className="bg-app-surface rounded shadow overflow-hidden">
          {isLoading ? (
            <div className="p-8 text-center text-app-dim"><Loader size={20} className="animate-spin mx-auto" /></div>
          ) : posts.length === 0 ? (
            <div className="p-8 text-center text-sm text-app-dim">Chua co bai nao duoc dang</div>
          ) : (
            <table className="w-full">
              <thead className="bg-app-base">
                <tr>
                  <th className="px-3 py-2 text-left text-xs font-medium text-app-muted">Noi dung</th>
                  <th className="px-3 py-2 text-left text-xs font-medium text-app-muted">Noi dang</th>
                  <th className="px-3 py-2 text-left text-xs font-medium text-app-muted">Thoi gian</th>
                  <th className="px-3 py-2 text-left text-xs font-medium text-app-muted">Trang thai</th>
                  <th className="px-3 py-2 text-center text-xs font-medium text-app-muted">Link</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {posts.map(post => (
                  <tr key={post.id} className="hover:bg-app-base">
                    <td className="px-3 py-2 text-xs text-app-primary max-w-[250px] truncate">
                      {post.final_caption || post.caption || '-'}
                    </td>
                    <td className="px-3 py-2 text-xs text-app-muted truncate max-w-[150px]">
                      {post.target_name || '-'}
                    </td>
                    <td className="px-3 py-2 text-xs text-app-muted whitespace-nowrap">
                      {post.published_at ? new Date(post.published_at).toLocaleString('vi') : '-'}
                    </td>
                    <td className="px-3 py-2">
                      <span className={`inline-flex items-center gap-1 text-xs px-1.5 py-0.5 rounded-full ${
                        post.status === 'success' ? 'bg-green-100 text-hermes' :
                        post.status === 'failed' ? 'bg-red-100 text-red-700' :
                        'bg-app-elevated text-app-muted'
                      }`}>
                        {post.status === 'success' ? <CheckCircle size={10} /> : post.status === 'failed' ? <AlertCircle size={10} /> : null}
                        {post.status === 'success' ? 'OK' : post.status}
                      </span>
                    </td>
                    <td className="px-3 py-2 text-center">
                      {(post.post_url || post.fb_post_id) ? (
                        <a
                          href={post.post_url || `https://www.facebook.com/${post.fb_post_id}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="inline-flex items-center gap-1 text-xs text-info hover:text-blue-800"
                        >
                          <ExternalLink size={12} /> Xem
                        </a>
                      ) : (
                        <span className="text-app-dim text-xs">-</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
    </div>
  )
}

export default function UnifiedPublish() {
  const nav = useNavigate()
  const { pathname } = useLocation()

  // Determine top-level active hub tab
  const getActiveHubTab = () => {
    if (pathname.startsWith('/content')) return 'content'
    if (pathname === '/media') return 'media'
    if (pathname === '/inbox') return 'inbox'
    return 'publish'
  }
  const activeHubTab = getActiveHubTab()

  return (
    <div className="flex flex-col h-full">
      {/* Consolidated Top Tabs Bar */}
      <div
        className="flex items-center px-6 font-mono-ui text-[11px] uppercase tracking-wider shrink-0"
        style={{ borderBottom: '1px solid var(--border)', background: 'var(--bg-elevated)' }}
      >
        <button
          onClick={() => nav('/publish')}
          className={`px-4 py-3 ${activeHubTab === 'publish' ? 'text-hermes' : 'text-app-muted hover:text-app-primary'}`}
          style={{
            borderBottom: activeHubTab === 'publish' ? '2px solid var(--hermes)' : '2px solid transparent',
            marginBottom: '-1px',
          }}
        >
          🚀 Xuất bản & Lịch
        </button>
        <button
          onClick={() => nav('/content')}
          className={`px-4 py-3 ${activeHubTab === 'content' ? 'text-hermes' : 'text-app-muted hover:text-app-primary'}`}
          style={{
            borderBottom: activeHubTab === 'content' ? '2px solid var(--hermes)' : '2px solid transparent',
            marginBottom: '-1px',
          }}
        >
          📝 Soạn thảo
        </button>
        <button
          onClick={() => nav('/media')}
          className={`px-4 py-3 ${activeHubTab === 'media' ? 'text-hermes' : 'text-app-muted hover:text-app-primary'}`}
          style={{
            borderBottom: activeHubTab === 'media' ? '2px solid var(--hermes)' : '2px solid transparent',
            marginBottom: '-1px',
          }}
        >
          🖼️ Tệp tin (Media)
        </button>
        <button
          onClick={() => nav('/inbox')}
          className={`px-4 py-3 ${activeHubTab === 'inbox' ? 'text-hermes' : 'text-app-muted hover:text-app-primary'}`}
          style={{
            borderBottom: activeHubTab === 'inbox' ? '2px solid var(--hermes)' : '2px solid transparent',
            marginBottom: '-1px',
          }}
        >
          📨 Hộp thư
        </button>
      </div>

      {/* Render Consolidated Views */}
      <div className="flex-1 min-h-0 overflow-y-auto">
        {activeHubTab === 'publish' && (
          <div className="p-6">
            <PublishTab />
          </div>
        )}
        {activeHubTab === 'content' && (
          <div className="p-6">
            {pathname === '/content/new' ? <ContentComposer /> : <ContentList />}
          </div>
        )}
        {activeHubTab === 'media' && (
          <div className="p-6">
            <MediaLibrary />
          </div>
        )}
        {activeHubTab === 'inbox' && (
          <div className="p-6 h-full">
            <InboxPage />
          </div>
        )}
      </div>
    </div>
  )
}
