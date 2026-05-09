const { getOrchestratorForUser } = require('../services/ai/orchestrator')

module.exports = async (fastify) => {
  const { supabase } = fastify

  // GET /ai/settings - Get AI settings (admin only)
  fastify.get('/settings', { preHandler: fastify.requireAdmin }, async (req, reply) => {
    const { data, error } = await supabase
      .from('ai_settings')
      .select('*')
      .eq('id', req.user.id)
      .single()

    if (error && error.code === 'PGRST116') {
      // No settings yet, return defaults
      return {
        id: req.user.id,
        providers: {},
        defaults: {},
        token_budgets: {},
        fallback_chain: ['deepseek', 'openai', 'gemini']
      }
    }
    if (error) return reply.code(500).send({ error: error.message })

    // Mask API keys for security
    const masked = { ...data }
    if (masked.providers) {
      for (const [key, val] of Object.entries(masked.providers)) {
        if (val.api_key) {
          masked.providers[key] = { ...val, api_key: val.api_key.substring(0, 8) + '...' }
        }
      }
    }
    return masked
  })

  // PUT /ai/settings - Update AI settings (admin only)
  fastify.put('/settings', { preHandler: fastify.requireAdmin }, async (req, reply) => {
    const { providers, defaults, token_budgets, fallback_chain, task_models } = req.body

    const { data, error } = await supabase
      .from('ai_settings')
      .upsert({
        id: req.user.id,
        ...(providers && { providers }),
        ...(defaults && { defaults }),
        ...(token_budgets && { token_budgets }),
        ...(fallback_chain && { fallback_chain }),
        ...(task_models !== undefined && { task_models }),
        updated_at: new Date().toISOString()
      })
      .select()
      .single()

    if (error) return reply.code(500).send({ error: error.message })
    return data
  })

  // POST /ai/test - Test a provider (admin only)
  fastify.post('/test', { preHandler: fastify.requireAdmin }, async (req, reply) => {
    const { provider, api_key, model } = req.body
    if (!provider || !api_key) return reply.code(400).send({ error: 'provider and api_key required' })

    try {
      const orchestrator = new (require('../services/ai/orchestrator').AIOrchestrator)({
        providers: { [provider]: { enabled: true, api_key } },
        fallback_chain: [provider]
      })

      const result = await orchestrator.call('caption_gen', [
        { role: 'user', content: 'Say "Hello from SocialFlow!" in one short sentence.' }
      ], { provider, model })

      return { success: true, response: result.text, tokens: { input: result.inputTokens, output: result.outputTokens } }
    } catch (err) {
      return { success: false, error: err.message }
    }
  })

  // POST /ai/generate - Generic AI generation (supports service-role key OR agent secret)
  fastify.post('/generate', async (req, reply) => {
    const { function_name, messages, provider, model, account_id, campaign_id } = req.body
    if (!messages?.length) return reply.code(400).send({ error: 'messages required' })

    // Allow service-role key, agent secret (either env name), OR authenticated user.
    // 2026-05-05: agent's lib/config.js stores its key under `AGENT_SECRET_KEY`
    // but the value matches API's `AGENT_SECRET` env (the names are reversed in
    // history). Without checking BOTH the agent gets 401 and falls back to
    // "AI unavailable — defaults" → 45-min rest gate kills throughput.
    const authHeader = req.headers.authorization || ''
    const isServiceKey = authHeader.includes(process.env.SUPABASE_SERVICE_ROLE_KEY || '___none___')
    const agentSecretA = process.env.AGENT_SECRET_KEY || ''
    const agentSecretB = process.env.AGENT_SECRET || ''
    const isAgentSecret =
      (agentSecretA && authHeader.includes(agentSecretA)) ||
      (agentSecretB && authHeader.includes(agentSecretB))
    if (!isServiceKey && !isAgentSecret) {
      try { await fastify.authenticate(req, reply) } catch { return }
    }
    const userId = req.user?.id || req.headers['x-user-id'] || ((isServiceKey || isAgentSecret) ? '274868cf-742d-4d8a-89e8-bf1c37766b77' : null)

    try {
      const orchestrator = await getOrchestratorForUser(userId, supabase)
      const result = await orchestrator.call(
        function_name || 'caption_gen',
        messages,
        { ...(provider && { provider }), ...(model && { model }), account_id, campaign_id }
      )

      return {
        text: result.text,
        provider: result.provider,
        tokens: { input: result.inputTokens, output: result.outputTokens }
      }
    } catch (err) {
      return reply.code(500).send({ error: err.message })
    }
  })

  // POST /ai/caption - Generate caption for content (enhanced)
  fastify.post('/caption', { preHandler: fastify.authenticate }, async (req, reply) => {
    const {
      topic, style, language, keywords, niche,
      include_cta, include_emoji, reference_caption, max_length,
      input_brief, reference_url
    } = req.body

    const styleGuides = {
      professional: 'Chuyên nghiệp, uy tín, dùng số liệu/thống kê nếu phù hợp. Tránh emoji quá nhiều.',
      casual: 'Thân thiện, gần gũi, như đang nói chuyện với bạn bè. Dùng emoji tự nhiên.',
      viral: `Viết bài Facebook dễ viral, PHẢI tuân thủ:

HOOK (câu đầu tiên):
- Phải gây SỐC, TÒ MÒ, hoặc TRANH CÃI nhẹ
- Ví dụ: "Mình vừa phát hiện 1 thứ mà 99% người dùng không biết..." hoặc "Nếu bạn chưa biết [CHỦ ĐỀ], bạn đang bỏ lỡ thứ sẽ thay đổi cách bạn làm việc"
- PHẢI nhắc đến TÊN chủ đề/sản phẩm/keyword chính ngay trong hook

THÂN BÀI:
- Mỗi ý 1-2 dòng, XUỐNG DÒNG NHIỀU, tạo khoảng trống giữa các đoạn
- Câu ngắn, dễ đọc trên điện thoại
- Nêu rõ: nó là gì, tại sao đặc biệt, ai nên dùng/biết
- Dùng so sánh bất ngờ hoặc số liệu gây ấn tượng
- KHÔNG dùng emoji (hoặc tối đa 1-2 nếu thật sự cần)
- KHÔNG dùng hashtag
- KHÔNG viết kiểu liệt kê khô khan — phải có cảm xúc, quan điểm cá nhân

KẾT BÀI:
- Câu hỏi kích thích tranh luận HOẶC CTA mạnh (tag bạn bè, share, save)
- Ví dụ: "Bạn đã thử chưa? Comment cho mình biết!" hoặc "Tag ngay 1 người cần biết điều này"

TONE: Tự nhiên như đang kể cho bạn bè nghe, KHÔNG giống marketing hay báo chí`,
      educational: 'Chia sẻ kiến thức, tips hữu ích, dạng "Bạn biết chưa?" hoặc listicle ngắn.',
      story: 'Kể chuyện cá nhân, trải nghiệm thực tế, tạo cảm xúc kết nối.',
      promotional: 'Quảng bá sản phẩm/dịch vụ, highlight lợi ích, có CTA rõ ràng.',
    }

    const styleDesc = styleGuides[style] || styleGuides.casual
    const lang = language === 'en' ? 'English' : 'Vietnamese'

    const rewriteBlock = reference_caption
      ? reference_caption.length > 500
        ? `=== BÀI VIẾT GỐC (đọc kỹ, lấy ý chính) ===
"""${reference_caption.substring(0, 3000)}"""

NHIỆM VỤ: Viết lại thành bài Facebook HOÀN TOÀN MỚI từ bài gốc trên.
- Giữ nguyên TÊN RIÊNG, SỐ LIỆU, KEYWORD CHÍNH
- KHÔNG copy câu gốc — diễn đạt lại bằng giọng riêng
- Thêm góc nhìn cá nhân, cảm xúc, hoặc trải nghiệm liên quan
- Mở bài bằng 1 câu khiến người ta PHẢI đọc tiếp`
        : `Caption cần viết lại: "${reference_caption}"
Giữ ý chính, viết lại hấp dẫn và tự nhiên hơn nhiều.`
      : ''

    const briefBlock = input_brief
      ? `=== THÔNG TIN ĐẦU VÀO (dùng làm nội dung chính) ===
"""${input_brief.substring(0, 3000)}"""
${reference_url ? `\nLINK THAM KHẢO: ${reference_url}` : ''}

NHIỆM VỤ: Dựa trên thông tin trên, viết bài Facebook hoàn chỉnh, chuyên nghiệp.
- Giữ nguyên tên riêng, số liệu, thông tin quan trọng từ đầu vào
- Biến thông tin khô khan thành bài viết hấp dẫn, có cảm xúc
- Thêm góc nhìn cá nhân, insight, hoặc lời khuyên liên quan`
      : ''

    let prompt = `Bạn là chuyên gia Content Marketing với 10 năm kinh nghiệm chuyên viết content Facebook. Bạn đã từng làm cho các agency lớn, hiểu sâu về tâm lý người đọc, biết cách biến thông tin khô khan nhất thành nội dung hấp dẫn đánh đúng tệp khách hàng mục tiêu.

BẮT BUỘC viết tiếng Việt CÓ DẤU đầy đủ. Viết ${lang}.

${briefBlock || `CHỦ ĐỀ: ${topic || 'general content'}`}
PHONG CÁCH: ${styleDesc}
${niche ? `LĨNH VỰC: ${niche}` : ''}
${keywords?.length ? `KEYWORDS BẮT BUỘC PHẢI CÓ: ${keywords.join(', ')}` : ''}

${rewriteBlock}

=== TƯ DUY CỦA BẠN KHI VIẾT ===
1. PHÂN TÍCH: Đọc kỹ thông tin đầu vào → xác định TỆP KHÁCH HÀNG mục tiêu (ai sẽ đọc bài này?)
2. GÓC TIẾP CẬN: Chọn góc nhìn độc đáo nhất — không viết giống mọi người, tìm insight bất ngờ từ dữ liệu cơ bản
3. CẤU TRÚC: Hook → Story/Value → CTA (mỗi phần phải có lý do tồn tại)

=== QUY TẮC VIẾT ===
1. HOOK (câu đầu): Phải khiến người đọc DỪNG SCROLL — dùng số liệu gây sốc, câu hỏi đánh vào pain point, hoặc statement ngược trend
2. THÂN BÀI: Mỗi ý 1-2 dòng, XUỐNG DÒNG tạo khoảng trống, tối ưu cho đọc trên điện thoại
3. GIỌNG VĂN: Như người có kinh nghiệm thực tế đang chia sẻ, có quan điểm rõ ràng, KHÔNG generic
4. GIÁ TRỊ: Mỗi câu phải có VALUE — kiến thức actionable, số liệu cụ thể, hoặc góc nhìn mới
5. CẢM XÚC: Kết nối cảm xúc với người đọc — đồng cảm, tò mò, hứng khởi, hoặc urgency
${include_cta !== false ? '6. KẾT: Câu hỏi kích thích TRANH LUẬN hoặc CTA cụ thể (tag ai, save bài, share cho ai)' : ''}
${include_emoji !== false ? '7. Emoji tự nhiên, vừa đủ (2-4 cái), đặt đúng chỗ nhấn mạnh — KHÔNG spam emoji' : '7. KHÔNG dùng emoji'}
${max_length ? `8. Giới hạn ${max_length} ký tự` : '8. Tối đa 500 ký tự'}

=== TUYỆT ĐỐI KHÔNG ===
- KHÔNG viết kiểu liệt kê bullet points khô khan
- KHÔNG mở bài bằng "Xin chào", "Hôm nay mình muốn chia sẻ", "Bạn có biết"
- KHÔNG kết bằng "Cảm ơn đã đọc", "Chúc các bạn", "Hy vọng bài viết hữu ích"
- KHÔNG dùng câu sáo rỗng: "Trong thời đại số", "Không thể phủ nhận", "Ai cũng biết"
- KHÔNG dùng hashtag trong caption (hashtag riêng bên dưới)
- KHÔNG viết giọng AI/robot — phải có cá tính, quan điểm, trải nghiệm cá nhân

=== FORMAT TRẢ VỀ ===
Trả về ĐÚNG format sau, không giải thích:

[CAPTION]
(nội dung caption ở đây)

[HASHTAGS]
(3-5 hashtag LỚN NHẤT của chủ đề, tiếng Việt có dấu, định dạng Facebook: mỗi hashtag viết liền không dấu cách, có dấu #)
VD: #CloudHosting #VPS #DịchVụWeb #HostingGiáRẻ`

    try {
      const orchestrator = await getOrchestratorForUser(req.user.id, supabase)
      const result = await orchestrator.call('caption_gen', [{ role: 'user', content: prompt }])
      const text = result.text.trim().replace(/^["']|["']$/g, '')

      // Parse caption + hashtags from response
      let captionText = text
      let hashtagsArr = []
      const captionMatch = text.match(/\[CAPTION\]\s*\n([\s\S]*?)(?:\[HASHTAGS\]|$)/i)
      const hashtagMatch = text.match(/\[HASHTAGS\]\s*\n([\s\S]*?)$/i)
      if (captionMatch) {
        captionText = captionMatch[1].trim()
      }
      if (hashtagMatch) {
        // Extract hashtags — keep # prefix for FB format
        const raw = hashtagMatch[1].trim()
        const tags = raw.match(/#[\w\u00C0-\u024F\u1E00-\u1EFF]+/g)
        if (tags?.length) {
          hashtagsArr = tags.map(h => h.trim()).slice(0, 5)
        } else {
          // Fallback: split by space, add # if missing
          hashtagsArr = raw.split(/[\s,]+/)
            .map(h => h.trim().replace(/^#/, ''))
            .filter(h => h.length > 0)
            .map(h => '#' + h)
            .slice(0, 5)
        }
      }

      const response = { caption: captionText }
      if (hashtagsArr.length > 0) response.hashtags = hashtagsArr
      return response
    } catch (err) {
      return reply.code(500).send({ error: err.message })
    }
  })

  // POST /ai/suggest-schedule - AI schedule suggestion
  fastify.post('/suggest-schedule', { preHandler: fastify.authenticate }, async (req, reply) => {
    const { target_type, target_id, count, timezone } = req.body
    const tz = timezone || 'Asia/Ho_Chi_Minh'
    const slotCount = count || 7

    // Default optimal times for Vietnamese Facebook users
    const defaultSchedule = {
      page: [
        { time: '07:00', days: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'], reason: 'Người dùng check Facebook buổi sáng' },
        { time: '12:00', days: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'], reason: 'Giờ nghỉ trưa - traffic cao' },
        { time: '17:30', days: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'], reason: 'Tan làm - scroll Facebook nhiều' },
        { time: '20:00', days: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'], reason: 'Prime time - engagement cao nhất' },
        { time: '09:00', days: ['Sat', 'Sun'], reason: 'Cuối tuần thư giãn' },
        { time: '15:00', days: ['Sat', 'Sun'], reason: 'Chiều cuối tuần - traffic ổn định' },
      ],
      group: [
        { time: '08:00', days: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'], reason: 'Sáng sớm - bài lên top group' },
        { time: '12:30', days: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'], reason: 'Giờ nghỉ trưa' },
        { time: '19:00', days: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'], reason: 'Tối - thời gian vàng cho groups' },
        { time: '21:00', days: ['Mon', 'Wed', 'Fri'], reason: 'Late night engagement' },
        { time: '10:00', days: ['Sat', 'Sun'], reason: 'Cuối tuần rảnh rỗi' },
      ],
    }

    try {
      // Try to get engagement data from publish_history
      let query = supabase.from('publish_history')
        .select('published_at, reach, reactions, comments, shares')
        .eq('status', 'success')
        .not('published_at', 'is', null)
        .order('published_at', { ascending: false })
        .limit(100)

      if (target_id) {
        if (target_type === 'page') {
          const { data: page } = await supabase.from('fanpages').select('fb_page_id').eq('id', target_id).single()
          if (page) query = query.eq('target_fb_id', page.fb_page_id)
        } else {
          const { data: group } = await supabase.from('fb_groups').select('fb_group_id').eq('id', target_id).single()
          if (group) query = query.eq('target_fb_id', group.fb_group_id)
        }
      }

      const { data: history } = await query

      // If we have engagement data, use AI to analyze
      if (history?.length >= 10) {
        const orchestrator = await getOrchestratorForUser(req.user.id, supabase)
        const historyStr = history.map(h => {
          const d = new Date(h.published_at)
          return `${d.toLocaleDateString('en', { weekday: 'short' })} ${d.toLocaleTimeString('en', { hour: '2-digit', minute: '2-digit', hour12: false })} - reach:${h.reach||0} reactions:${h.reactions||0} comments:${h.comments||0} shares:${h.shares||0}`
        }).join('\n')

        const result = await orchestrator.call('content_ideas', [{
          role: 'user',
          content: `Phân tích dữ liệu engagement từ Facebook ${target_type || 'page'} và gợi ý ${slotCount} thời điểm đăng bài tốt nhất (timezone ${tz}).

Data:
${historyStr}

Return JSON array: [{ "time": "HH:MM", "days": ["Mon","Tue",...], "reason": "..." }]
Chỉ trả về JSON, không giải thích.`
        }])

        try {
          const jsonMatch = result.text.match(/\[[\s\S]*\]/)
          if (jsonMatch) {
            return { schedule: JSON.parse(jsonMatch[0]), source: 'ai_analyzed', data_points: history.length }
          }
        } catch {}
      }

      // Fallback to default schedule
      const schedule = (defaultSchedule[target_type] || defaultSchedule.page).slice(0, slotCount)
      return { schedule, source: 'default', data_points: history?.length || 0 }

    } catch (err) {
      return reply.code(500).send({ error: err.message })
    }
  })

  // POST /ai/hashtags - Generate hashtags
  fastify.post('/hashtags', { preHandler: fastify.authenticate }, async (req, reply) => {
    const { caption, count } = req.body
    if (!caption) return reply.code(400).send({ error: 'caption required' })

    const prompt = `Generate ${count || 15} relevant hashtags for this Facebook post: "${caption}".
    
CRITICAL RULES:
1. Return ONLY a valid JSON array of strings (e.g. ["hashtag1", "hashtag2"]).
2. Do NOT include the '#' symbol in the strings.
3. Do NOT wrap the output in markdown code blocks (no \`\`\`json or \`\`\`).
4. Just output the raw array and nothing else.`

    try {
      const orchestrator = await getOrchestratorForUser(req.user.id, supabase)
      const result = await orchestrator.call('hashtag_gen', [{ role: 'user', content: prompt }])

      try {
        const hashtags = JSON.parse(result.text)
        return { hashtags: Array.isArray(hashtags) ? hashtags : [] }
      } catch {
        const matches = result.text.match(/#?\w+/g) || []
        return { hashtags: matches.map(h => h.replace('#', '')) }
      }
    } catch (err) {
      return reply.code(500).send({ error: err.message })
    }
  })

  // POST /ai/ideas - Generate content ideas
  fastify.post('/ideas', { preHandler: fastify.authenticate }, async (req, reply) => {
    const { niche, count } = req.body

    const prompt = `Suggest ${count || 10} content ideas for a Facebook page about: ${niche || 'general topics'}.
For each idea, provide:
- Title (short)
- Description (1 sentence)
- Best time to post
Return as JSON array: [{ "title": "...", "description": "...", "best_time": "..." }]`

    try {
      const orchestrator = await getOrchestratorForUser(req.user.id, supabase)
      const result = await orchestrator.call('content_ideas', [{ role: 'user', content: prompt }])

      try {
        return { ideas: JSON.parse(result.text) }
      } catch {
        return { ideas: result.text }
      }
    } catch (err) {
      return reply.code(500).send({ error: err.message })
    }
  })

  // POST /ai/image-prompt - Extract keywords from caption & generate image prompt
  fastify.post('/image-prompt', { preHandler: fastify.authenticate }, async (req, reply) => {
    const { caption } = req.body
    if (!caption) return reply.code(400).send({ error: 'caption required' })

    // Truncate caption for prompt generation (avoid sending 15k chars to AI)
    const captionForPrompt = caption.length > 1000 ? caption.substring(0, 1000) : caption

    const prompt = `You are a world-class creative director and marketing design expert who specializes in scroll-stopping social media visuals. You think like the top 1% of designers at agencies like Ogilvy, Dentsu, and Wieden+Kennedy.

Your mission: Read this Facebook post and craft a prompt that generates an image so compelling it STOPS people from scrolling.

Facebook post:
"""
${captionForPrompt}
"""

=== YOUR CREATIVE PROCESS ===

1. EXTRACT THE HERO ELEMENT:
   - What is the ONE thing this post is about? (product, concept, emotion, event)
   - This becomes the HERO — the dominant visual that takes 70%+ of the frame

2. CHOOSE THE VISUAL STRATEGY (pick the best fit):
   - PRODUCT HERO: Dramatic product shot with studio lighting, floating in space, cinematic angles
   - CONCEPT METAPHOR: Powerful visual metaphor that makes abstract ideas tangible and emotional
   - EMOTION TRIGGER: Scene that evokes the core feeling (excitement, urgency, curiosity, aspiration)
   - DATA VISUALIZATION: For stats/numbers — turn data into stunning 3D infographic-style visuals

3. APPLY MARKETING DESIGN PRINCIPLES:
   - Color psychology: warm = urgency/passion, cool = trust/tech, contrast = attention
   - Composition: rule of thirds, leading lines, negative space for impact
   - Lighting: dramatic rim light, volumetric fog, golden hour, neon accents
   - Depth: bokeh background, layered elements, atmospheric perspective

=== ABSOLUTE RULES ===
- NO generic stock-photo vibes (people shaking hands, team at desk, person on laptop)
- NO text, words, logos, watermarks, UI mockups with readable text
- The image alone must communicate the post's core message — viewer gets it in 0.5 seconds
- Style: photorealistic, 3D cinematic render, or high-end editorial photography
- English ONLY
- Output ONLY the raw prompt, 60-100 words. NO intro, NO explanation, NO quotes.

=== EXAMPLE ===
Post about "cloud hosting with 99.9% uptime":
A colossal glass server tower floating in the sky above clouds, bathed in warm golden sunset light, glowing fiber optic cables streaming upward like aurora borealis, tiny city skyline below for scale, volumetric god rays piercing through cloud layers, hyperrealistic 3D render, shallow depth of field, teal and amber color palette`

    try {
      const orchestrator = await getOrchestratorForUser(req.user.id, supabase)
      const result = await orchestrator.call('caption_gen', [{ role: 'user', content: prompt }])
      return { prompt: result.text.trim().replace(/^["']|["']$/g, '') }
    } catch (err) {
      return reply.code(500).send({ error: err.message })
    }
  })

  // POST /ai/generate-image - Generate image using fal.ai
  fastify.post('/generate-image', { preHandler: fastify.authenticate }, async (req, reply) => {
    const { prompt, model, image_size, negative_prompt } = req.body
    if (!prompt) return reply.code(400).send({ error: 'prompt required' })

    try {
      // Step 1: Generate image via fal.ai
      let orchestrator
      try {
        orchestrator = await getOrchestratorForUser(req.user.id, supabase)
      } catch (err) {
        req.log.error({ err }, 'generate-image: failed to get orchestrator (DB/auth issue)')
        return reply.code(503).send({ error: 'Không thể kết nối database. Thử lại sau.' })
      }

      let result
      try {
        result = await orchestrator.generateImage(prompt, { model, image_size, negative_prompt })
      } catch (err) {
        let msg = err.message
        if (err.detail) msg = err.detail // Catch the detail exposed by fal.js
        else if (err.response && err.response.data) {
          msg = err.response.data.detail || JSON.stringify(err.response.data)
        }
        req.log.error({ err, msg, model, prompt: prompt.substring(0, 100) }, 'generate-image: fal.ai call failed')
        return reply.code(502).send({ error: `Fal.ai từ chối: ${msg}` })
      }

      // Step 2: Get URL from result
      const imageUrl = result.images?.[0]?.url
      if (!imageUrl) {
        req.log.error({ result }, 'generate-image: no image URL in response')
        return reply.code(502).send({ error: 'fal.ai không trả về ảnh. Thử model khác.' })
      }

      // Step 3: Download & upload to R2
      const axios = require('axios')
      const https = require('https')
      const dns = require('dns').promises
      const { v4: uuid } = require('uuid')
      let buffer
      try {
        if (imageUrl.startsWith('data:image/')) {
          const base64Data = imageUrl.split(',')[1]
          buffer = Buffer.from(base64Data, 'base64')
        } else {
          // Normal HTTP URL
          let targetUrl = imageUrl
          let headers = {}
          
          try {
            // First try to resolve it via DNS-over-HTTPS to bypass completely broken Windows local DNS caching
            const parsedUrl = new URL(imageUrl)
            
            req.log.info({ host: parsedUrl.hostname }, 'Attempting DNS-over-HTTPS resolution')
            const dnsResp = await axios.get(`https://cloudflare-dns.com/dns-query?name=${parsedUrl.hostname}&type=A`, {
              headers: { 'accept': 'application/dns-json' },
              timeout: 5000
            })
            
            if (dnsResp.data?.Answer?.[0]?.data) {
              const address = dnsResp.data.Answer[0].data
              targetUrl = imageUrl.replace(parsedUrl.hostname, address)
              headers['Host'] = parsedUrl.hostname
              req.log.info({ host: parsedUrl.hostname, ip: address }, 'Resolved fal.media DNS via Cloudflare DoH')
            } else {
              throw new Error('No A record found in DoH response')
            }
          } catch (dnsErr) {
            req.log.warn({ err: dnsErr.message }, 'DoH lookup failed, falling back to default Axios routing')
          }

          const agent = new https.Agent({ rejectUnauthorized: false }) // IP cert will mismatch hostname
          const imgResp = await axios.get(targetUrl, { 
            headers,
            responseType: 'arraybuffer', 
            timeout: 30000,
            httpsAgent: agent
          })
          buffer = Buffer.from(imgResp.data)
        }
      } catch (err) {
        req.log.error({ err, imageUrl }, 'generate-image: failed to download from fal.ai')
        return reply.code(502).send({ error: 'Không thể tải ảnh từ fal.ai do lỗi mạng' })
      }

      const mediaId = uuid()
      const r2Key = `images/generated/${req.user.id}/${mediaId}.png`
      let publicUrl = r2Key
      try {
        publicUrl = await fastify.uploadToR2(r2Key, buffer, 'image/png')
      } catch (err) {
        if (err.message === 'R2 storage not configured') {
          req.log.warn('R2 storage not configured, falling back to base64 Data URI')
          publicUrl = `data:image/png;base64,${buffer.toString('base64')}`
        } else {
          req.log.error({ err }, 'generate-image: R2 upload failed')
          return reply.code(502).send({ error: 'Không thể upload ảnh lên storage' })
        }
      }

      // Step 4: Save to media table
      await supabase.from('media').insert({
        id: mediaId,
        owner_id: req.user.id,
        type: 'image',
        source_type: 'generated',
        original_path: publicUrl,
        title: `AI: ${prompt.substring(0, 80)}`,
        file_size_bytes: buffer.length,
        processing_status: 'done',
      })

      return {
        id: mediaId,
        url: publicUrl,
        title: `AI: ${prompt.substring(0, 80)}`,
        prompt,
        model: model || 'fal-ai/flux/schnell',
      }
    } catch (err) {
      req.log.error({ err }, 'generate-image: unexpected error')
      return reply.code(500).send({ error: err.message })
    }
  })

  async function getHashtagPresets(userId) {
    const { data } = await supabase.from('ai_settings').select('defaults').eq('id', userId).single()
    return data?.defaults?.hashtag_presets || []
  }

  async function saveHashtagPresets(userId, presets) {
    // Read current defaults, merge hashtag_presets in
    const { data } = await supabase.from('ai_settings').select('defaults').eq('id', userId).single()
    const currentDefaults = data?.defaults || {}
    await supabase.from('ai_settings').upsert({
      id: userId,
      defaults: { ...currentDefaults, hashtag_presets: presets },
      updated_at: new Date().toISOString(),
    })
  }

  // POST /ai/comment - Generate contextual comment for campaign automation
  // Accepts authenticated users, service-role key, OR agent secret key
  fastify.post('/comment', async (req, reply) => {
    const { post_snippet, group_name, topic, style, language, user_id } = req.body

    // Allow service-role key, agent secret (either env name), OR authenticated user.
    // 2026-05-05: agent's lib/config.js stores its key under `AGENT_SECRET_KEY`
    // but the value matches API's `AGENT_SECRET` env (the names are reversed in
    // history). Without checking BOTH the agent gets 401 and falls back to
    // "AI unavailable — defaults" → 45-min rest gate kills throughput.
    const authHeader = req.headers.authorization || ''
    const isServiceKey = authHeader.includes(process.env.SUPABASE_SERVICE_ROLE_KEY || '___none___')
    const agentSecretA = process.env.AGENT_SECRET_KEY || ''
    const agentSecretB = process.env.AGENT_SECRET || ''
    const isAgentSecret =
      (agentSecretA && authHeader.includes(agentSecretA)) ||
      (agentSecretB && authHeader.includes(agentSecretB))
    if (!isServiceKey && !isAgentSecret) {
      try { await fastify.authenticate(req, reply) } catch { return }
    }

    const userId = req.user?.id || user_id || ((isServiceKey || isAgentSecret) ? '274868cf-742d-4d8a-89e8-bf1c37766b77' : null)
    if (!userId) return reply.code(400).send({ error: 'user_id required' })

    const isEnglish = language === 'en'
    const commentStyle = style || 'casual'

    // If client provided a custom_prompt, use that directly (allows full language override)
    const styleGuides = isEnglish ? {
      casual: 'Friendly, conversational',
      expert: 'Professional, add relevant knowledge',
      enthusiastic: 'Enthusiastic, positive',
    } : {
      casual: 'Thân thiện, tự nhiên như đang nói chuyện',
      expert: 'Chuyên nghiệp, thêm kiến thức liên quan',
      enthusiastic: 'Nhiệt tình, hào hứng, tích cực',
    }

    const prompt = req.body.custom_prompt
      ? req.body.custom_prompt
      : (isEnglish ? `Write ONE Facebook comment in NATURAL ENGLISH.

=== ORIGINAL POST (in group "${group_name || 'general'}") ===
"${(post_snippet || '').substring(0, 500)}"

=== STRICT RULES ===
1. Read the post carefully, understand what the author means
2. Comment MUST respond directly to the post:
   - If they ASK → answer or share related experience
   - If they SHARE → comment on what they shared, ask for details
   - If they ADVERTISE → show interest or ask about price/details
3. Don't write generic comments like "great", "awesome"
4. Don't mention topic "${topic}" unless the post is directly related
5. Tone: ${styleGuides[commentStyle] || styleGuides.casual}
6. Max 1-2 sentences, max 1 emoji
7. No hashtags, no links
8. Natural like a real person talking

Return ONLY the comment, no explanation.` : `Viết MỘT bình luận Facebook bằng tiếng Việt tự nhiên.

=== BÀI VIẾT GỐC (trong nhóm "${group_name || 'chung'}") ===
"${(post_snippet || '').substring(0, 500)}"

=== QUY TẮC BẮT BUỘC ===
1. ĐỌC KỸ bài viết, HIỂU nội dung người đăng muốn nói gì
2. Bình luận PHẢI TRẢ LỜI/PHẢN HỒI đúng nội dung bài viết:
   - Nếu họ HỎI → trả lời hoặc chia sẻ kinh nghiệm liên quan
   - Nếu họ CHIA SẺ → bình luận về điều họ chia sẻ, hỏi thêm chi tiết
   - Nếu họ QUẢNG CÁO → bình luận quan tâm hoặc hỏi giá/chi tiết
3. KHÔNG viết comment chung chung kiểu "hay quá", "tuyệt vời"
4. KHÔNG đề cập chủ đề "${topic}" nếu bài viết KHÔNG liên quan trực tiếp
5. Giọng: ${styleGuides[commentStyle] || styleGuides.casual}
6. 2-3 câu, 40-70 chữ. KHÔNG viết 1 câu cụt rồi dừng
7. KHÔNG hashtag, KHÔNG link, tối đa 1 emoji
8. CẤU TRÚC: ý chính + câu bổ trợ (giải thích, dẫn chứng, hoặc mở rộng). VD: "Nên dùng tool hợp lý hơn bạn ạ. Openclaw nó như trợ lý cá nhân AI thôi"
9. Dùng từ đệm tiếng Việt tự nhiên: ạ, nhé, nha, á, thôi, mà, nè, luôn, đấy, chứ — tuỳ ngữ cảnh
10. Xưng hô: mình/bạn/bác/anh/chị tuỳ ngữ cảnh nhóm. KHÔNG xưng "tôi"

Chỉ trả về NỘI DUNG bình luận, không giải thích.`)

    try {
      const orchestrator = await getOrchestratorForUser(userId, supabase)
      const result = await orchestrator.call('caption_gen', [
        { role: 'user', content: prompt },
      ], { max_tokens: 100, temperature: 0.9 })

      const comment = (result?.text || '').trim().replace(/^["']|["']$/g, '')
      if (!comment) return reply.code(500).send({ error: 'AI returned empty comment' })

      return { comment, provider: result?.provider || 'hermes', model: result?.model || null }
    } catch (err) {
      console.error('[AI-COMMENT] Error:', err.message)
      return reply.code(500).send({ error: err.message })
    }
  })

  // POST /ai/evaluate - AI Brain quality gate + relevance evaluation
  // Used by agent and frontend to check content/post relevance
  fastify.post('/evaluate', async (req, reply) => {
    const { type, data: evalData, topic, campaign, ownerId, account_id, campaign_id } = req.body
    const userId = ownerId || req.body.user_id || req.user?.id

    if (!type || !evalData) {
      return reply.code(400).send({ error: 'type and data required' })
    }

    const orchestrator = await getOrchestratorForUser(userId, supabase)

    try {
      if (type === 'post_relevance') {
        // Evaluate if a post is relevant to campaign topic
        const { post_text, group_name, author } = evalData
        const result = await orchestrator.call('relevance_review', [{
          role: 'user',
          content: `Đánh giá bài viết này có LIÊN QUAN đến chủ đề "${topic}" không:

Nhóm: "${group_name || '?'}"
Tác giả: ${author || '?'}
Nội dung: "${(post_text || '').substring(0, 400)}"

Chiến dịch: ${campaign?.name || topic}
Đối tượng mục tiêu: Người CÓ NHU CẦU về "${topic}" (người mua/dùng)

Trả về JSON:
            "comment_angle": "gợi ý góc bình luận nếu đáng"}`
        }], { max_tokens: 150, temperature: 0, account_id, campaign_id })

        const text = result?.text || ''
        const match = text.match(/\{[\s\S]*?\}/)
        if (match) return JSON.parse(match[0])
        return { relevant: false, score: 0, reason: 'parse_failed' }
      }

      if (type === 'comment_quality') {
        // Quality gate for generated comment
        const { comment, post_text, group_name } = evalData
        const result = await orchestrator.call('quality_gate', [{
          role: 'user',
          content: `Đánh giá bình luận Facebook:

BÀI GỐC (nhóm "${group_name || '?'}"): "${(post_text || '').substring(0, 200)}"
BÌNH LUẬN: "${comment}"
CHỦ ĐỀ: "${topic || 'N/A'}"

Chấm điểm 1-10:
- naturalness: Tự nhiên như người thật?
- relevance: Trả lời đúng nội dung bài?
- value: Mang lại giá trị cho cuộc trò chuyện?

JSON: {"naturalness": N, "relevance": N, "value": N, "approved": true/false, "reason": "..."}`
        }], { max_tokens: 100, temperature: 0, account_id, campaign_id })

        const text = result?.text || ''
        const match = text.match(/\{[\s\S]*?\}/)
        if (match) {
          const r = JSON.parse(match[0])
          const avg = ((r.naturalness || 0) + (r.relevance || 0) + (r.value || 0)) / 3
          return { ...r, avg_score: Math.round(avg * 10) / 10, approved: avg >= 6.5 }
        }
        return { approved: true, reason: 'parse_failed_default_allow' }
      }

      if (type === 'lead_quality') {
        // Score potential lead
        const { name, context: leadContext } = evalData
        const result = await orchestrator.call('lead_score', [{
          role: 'user',
          content: `Đánh giá người này có phải KHÁCH TIỀM NĂNG cho "${topic}" không:

Tên: ${name || '?'}
Ngữ cảnh: ${leadContext || 'Tương tác trong nhóm Facebook'}

Dấu hiệu KHÁCH TỐT: Hỏi giá, so sánh, tìm giải pháp
Dấu hiệu KHÔNG PHẢI: Đối thủ bán cùng loại, spam, quảng cáo

JSON: {"score": 0-10, "worth": true/false, "reason": "...", "type": "potential_buyer|competitor|irrelevant"}`
        }], { max_tokens: 80, temperature: 0 })

        const text = result?.text || ''
        const match = text.match(/\{[\s\S]*?\}/)
        if (match) return JSON.parse(match[0])
        return { score: 5, worth: true, reason: 'parse_failed_default', type: 'unknown' }
      }

      return reply.code(400).send({ error: `Unknown evaluation type: ${type}` })
    } catch (err) {
      console.error('[AI-EVALUATE] Error:', err.message)
      return reply.code(500).send({ error: err.message })
    }
  })

  // GET /ai/hashtag-presets - List saved presets
  fastify.get('/hashtag-presets', { preHandler: fastify.authenticate }, async (req, reply) => {
    try {
      return await getHashtagPresets(req.user.id)
    } catch (err) {
      return reply.code(500).send({ error: err.message })
    }
  })

  // POST /ai/hashtag-presets - Save a new preset
  fastify.post('/hashtag-presets', { preHandler: fastify.authenticate }, async (req, reply) => {
    const { name, tags } = req.body
    if (!name || !tags?.length) return reply.code(400).send({ error: 'name and tags required' })

    try {
      const presets = await getHashtagPresets(req.user.id)
      const newPreset = {
        id: Date.now().toString(),
        name: name.trim(),
        tags: tags.map(t => t.replace(/^#/, '').trim()).filter(Boolean),
        createdAt: new Date().toISOString(),
      }
      presets.unshift(newPreset)
      await saveHashtagPresets(req.user.id, presets)
      return newPreset
    } catch (err) {
      return reply.code(500).send({ error: err.message })
    }
  })

  // DELETE /ai/hashtag-presets/:id - Delete a preset
  fastify.delete('/hashtag-presets/:id', { preHandler: fastify.authenticate }, async (req, reply) => {
    try {
      const presets = await getHashtagPresets(req.user.id)
      const filtered = presets.filter(p => p.id !== req.params.id)
      if (filtered.length === presets.length) return reply.code(404).send({ error: 'Not found' })
      await saveHashtagPresets(req.user.id, filtered)
      return { success: true }
    } catch (err) {
      return reply.code(500).send({ error: err.message })
    }
  })
}
