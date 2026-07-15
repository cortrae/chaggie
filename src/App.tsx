import { useState, useEffect, useRef } from 'react'
import './App.css'

type Platform = 'twitch' | 'kick' | 'youtube' | 'x'

interface ChatMessage {
  id: string
  platform: Platform
  username: string
  channel?: string
  text: string
  timestamp: Date
  matchedKeywords?: Keyword[]
}

interface Keyword {
  text: string
  color: string
}

interface Source {
  id: string
  platform: Platform
  value: string
  label?: string
  broadcastId?: string
}

interface Config {
  sources: Source[]
  youtubeApiKey: string
  twitchClientId?: string
  twitchClientSecret?: string
  keywords: Keyword[]
  mutedUsers: string[]
}

interface ActivityPoint {
  time: number
  twitch: number
  kick: number
  youtube: number
  x: number
}

interface SpikeEvent {
  id: string
  time: number
  timeLabel: string
  total: number
  topKeywords: { text: string, count: number, color: string }[]
  messages: ChatMessage[]
}

const PLATFORM_COLORS: Record<Platform, string> = {
  twitch: '#b9a3e3',
  kick: '#53fc18',
  youtube: '#ff4444',
  x: '#4a9eed',
}

const PLATFORM_LABELS: Record<Platform, string> = {
  twitch: 'TTV',
  kick: 'KICK',
  youtube: 'YT',
  x: 'X',
}

const DEFAULT_KEYWORDS: Keyword[] = [
  { text: '$BTC', color: '#f7931a' },
  { text: '$ETH', color: '#627eea' },
  { text: '$SPY', color: '#00d964' },
  { text: '$SPX', color: '#00d964' },
  { text: '$QQQ', color: '#00aaff' },
]

function getStreamEmbedUrl(source: Source): string {
  const channel = source.value.replace('@', '')
  if (source.platform === 'twitch') return `https://player.twitch.tv/?channel=${channel}&parent=localhost&autoplay=true&muted=true`
  if (source.platform === 'kick') return `https://player.kick.com/${channel}`
  if (source.platform === 'youtube') return `https://www.youtube.com/embed/${channel}?autoplay=1&mute=1`
  return ''
}

function highlightText(text: string, keywords: Keyword[]) {
  if (!keywords.length) return <span>{text}</span>
  const pattern = new RegExp(`(${keywords.map(k => k.text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`, 'gi')
  const parts = text.split(pattern)
  return (
    <>
      {parts.map((part, i) => {
        const match = keywords.find(k => k.text.toLowerCase() === part.toLowerCase())
        if (match) return <span key={i} style={{ color: match.color, fontWeight: 'bold', textShadow: `0 0 10px ${match.color}cc`, letterSpacing: '0.5px' }}>{part}</span>
        return <span key={i}>{part}</span>
      })}
    </>
  )
}

function ActivityGraph({ data, height = 70 }: { data: ActivityPoint[], height?: number }) {
  const maxVal = Math.max(1, ...data.flatMap(d => [d.twitch, d.kick, d.youtube, d.x]))
  const w = 100
  const h = height

  const toPath = (platform: Platform) => {
    if (data.length < 2) return ''
    return data.map((d, i) => {
      const x = (i / (data.length - 1)) * w
      const y = h - (d[platform] / maxVal) * h
      return `${i === 0 ? 'M' : 'L'} ${x} ${y}`
    }).join(' ')
  }

  const avg = data.length > 3
    ? data.slice(-12).reduce((a, d) => a + d.twitch + d.kick + d.youtube + d.x, 0) / Math.min(data.length, 12)
    : 0

  const spikes = data.map((d, i) => {
    const total = d.twitch + d.kick + d.youtube + d.x
    if (total > avg * 2 && avg > 0 && data.length > 1) {
      const x = (i / (data.length - 1)) * w
      const time = new Date(d.time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
      return { x, time, total }
    }
    return null
  }).filter(Boolean) as { x: number, time: string, total: number }[]

  return (
    <svg viewBox={`0 0 ${w} ${h + 16}`} style={{ width: '100%', height: height + 16 }} preserveAspectRatio="none">
      {(['twitch', 'kick', 'youtube', 'x'] as Platform[]).map(p => (
        <path key={p} d={toPath(p)} fill="none" stroke={PLATFORM_COLORS[p]} strokeWidth="0.8" opacity="0.8" vectorEffect="non-scaling-stroke" />
      ))}
      {spikes.map((spike, i) => (
        <g key={i}>
          <line x1={spike.x} y1={0} x2={spike.x} y2={h} stroke="#ff444466" strokeWidth="0.5" vectorEffect="non-scaling-stroke" strokeDasharray="2,2" />
          <text x={spike.x} y={h + 12} fill="#ff6666" fontSize="4" textAnchor="middle" vectorEffect="non-scaling-stroke" style={{ fontFamily: 'IBM Plex Mono, monospace' }}>
            {spike.time}
          </text>
        </g>
      ))}
    </svg>
  )
}

export default function App() {
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [config, setConfig] = useState<Config>(() => {
    try {
      const saved = localStorage.getItem('chaggie_config_v3')
      if (saved) return JSON.parse(saved)
    } catch {}
    return { sources: [], youtubeApiKey: '', keywords: DEFAULT_KEYWORDS, mutedUsers: [] }
  })

  const [showConfig, setShowConfig] = useState(false)
  const [activeStreamId, setActiveStreamId] = useState<string | null>(null)
  const [newSourcePlatform, setNewSourcePlatform] = useState<Platform>('twitch')
  const [newSourceValue, setNewSourceValue] = useState('')
  const [newSourceLabel, setNewSourceLabel] = useState('')
  const [newSourceBroadcastId, setNewSourceBroadcastId] = useState('')
  const [keywordInput, setKeywordInput] = useState('')
  const [keywordColor, setKeywordColor] = useState('#f7931a')
  const [muteInput, setMuteInput] = useState('')
  const [autoScroll, setAutoScroll] = useState(true)
  const [filter, setFilter] = useState<'all' | Platform>('all')
  const [connected, setConnected] = useState(false)
  const [activity, setActivity] = useState<ActivityPoint[]>([])
  const [msgPerMin, setMsgPerMin] = useState<Record<Platform, number>>({ twitch: 0, kick: 0, youtube: 0, x: 0 })
  const [keywordCounts, setKeywordCounts] = useState<Record<string, number>>({})
  const [densityHistory, setDensityHistory] = useState<number[]>([])
  const [spikeLog, setSpikeLog] = useState<SpikeEvent[]>([])
  const [showSpikeLog, setShowSpikeLog] = useState(false)
  const [selectedSpike, setSelectedSpike] = useState<SpikeEvent | null>(null)
  const [xPreloadPath, setXPreloadPath] = useState<string>('')
  const [xMounted, setXMounted] = useState(false)

  // ---- viewer count system (isolated from activity chart) ----
  const [viewers, setViewers] = useState<Record<string, number | null>>({})
  const [xOccupancy, setXOccupancy] = useState<number | null>(null)
  const [audiencePulse, setAudiencePulse] = useState(false)
  const prevAudienceRef = useRef(0)

  const feedRef = useRef<HTMLDivElement>(null)
  const wsRefs = useRef<Map<string, WebSocket>>(new Map())
  const youtubeRefs = useRef<Map<string, ReturnType<typeof setInterval>>>(new Map())
  const youtubeTokens = useRef<Map<string, string>>(new Map())
  const xViewRef = useRef<any>(null)
  const connectionGen = useRef(0)
  const viewerPollRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const activityBucket = useRef<Record<Platform, number>>({ twitch: 0, kick: 0, youtube: 0, x: 0 })
  const activityTimerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const keywordCountsRef = useRef<Record<string, number>>({})
  const messagesRef = useRef<ChatMessage[]>([])
  const densityHistoryRef = useRef<number[]>([])
  const twitchTokenRef = useRef<string>('')

  const getDensityLabel = (current: number, history: number[]): { label: string, color: string } => {
    if (history.length < 3) return { label: 'WARMING', color: '#555' }
    const avg = history.slice(-6).reduce((a, b) => a + b, 0) / Math.min(history.length, 6)
    if (current > avg * 1.5) return { label: 'HOT', color: '#ff4444' }
    if (current > avg * 1.1) return { label: 'ACTIVE', color: '#f7931a' }
    if (current < avg * 0.5) return { label: 'QUIET', color: '#444' }
    return { label: 'STEADY', color: '#00d964' }
  }

  const addMessage = (msg: Omit<ChatMessage, 'id' | 'timestamp' | 'matchedKeywords'>) => {
    const matchedKeywords = config.keywords.filter(k => msg.text.toLowerCase().includes(k.text.toLowerCase()))
    activityBucket.current[msg.platform]++
    matchedKeywords.forEach(k => {
      keywordCountsRef.current[k.text] = (keywordCountsRef.current[k.text] || 0) + 1
    })
    const newMsg: ChatMessage = { ...msg, id: Math.random().toString(36).slice(2), timestamp: new Date(), matchedKeywords }
    messagesRef.current = [...messagesRef.current.slice(-500), newMsg]
    setMessages(prev => [...prev.slice(-500), newMsg])
  }

  const connectTwitch = (source: Source) => {
    const existing = wsRefs.current.get(source.id)
    if (existing) existing.close()
    const ws = new WebSocket('wss://irc-ws.chat.twitch.tv:443')
    wsRefs.current.set(source.id, ws)
    ws.onopen = () => {
      ws.send('PASS oauth:chaggie_anonymous')
      ws.send('NICK justinfan' + Math.floor(Math.random() * 99999))
      ws.send(`JOIN #${source.value.toLowerCase()}`)
    }
    ws.onmessage = (e) => {
      const raw = e.data as string
      if (raw.includes('PING')) { ws.send('PONG :tmi.twitch.tv'); return }
      const match = raw.match(/:(\w+)!\w+@\w+\.tmi\.twitch\.tv PRIVMSG #\w+ :(.+)/)
      if (match) addMessage({ platform: 'twitch', username: match[1], channel: source.label || source.value, text: match[2].trim() })
    }
  }

  const connectKick = (source: Source) => {
    const existing = wsRefs.current.get(source.id)
    if (existing) existing.close()
    const gen = connectionGen.current
    fetch(`https://kick.com/api/v1/channels/${source.value}`)
      .then(r => r.json())
      .then(data => {
        if (gen !== connectionGen.current) return
        const chatroomId = data?.chatroom?.id
        if (!chatroomId) return
        const ws = new WebSocket(`wss://ws-us2.pusher.com/app/32cbd69e4b950bf97679?protocol=7&client=js&version=7.6.0&flash=false`)
        wsRefs.current.set(source.id, ws)
        ws.onopen = () => ws.send(JSON.stringify({ event: 'pusher:subscribe', data: { auth: '', channel: `chatrooms.${chatroomId}.v2` } }))
        ws.onmessage = (e) => {
          const payload = JSON.parse(e.data)
          if (payload.event === 'App\\Events\\ChatMessageEvent') {
            const msg = JSON.parse(payload.data)
            addMessage({ platform: 'kick', username: msg.sender?.username || 'unknown', channel: source.label || source.value, text: msg.content })
          }
        }
      }).catch(() => {})
  }

  const connectYoutube = (source: Source) => {
    const existing = youtubeRefs.current.get(source.id)
    if (existing) clearInterval(existing)
    const apiKey = config.youtubeApiKey || localStorage.getItem('yt_api_key') || ''
    if (!apiKey) return
    const fetchChat = () => {
      fetch(`https://www.googleapis.com/youtube/v3/videos?part=liveStreamingDetails&id=${source.value}&key=${apiKey}`)
        .then(r => r.json())
        .then(data => {
          const chatId = data?.items?.[0]?.liveStreamingDetails?.activeLiveChatId
          if (!chatId) return
          const url = new URL('https://www.googleapis.com/youtube/v3/liveChat/messages')
          url.searchParams.set('part', 'snippet,authorDetails')
          url.searchParams.set('liveChatId', chatId)
          url.searchParams.set('key', apiKey)
          const token = youtubeTokens.current.get(source.id)
          if (token) url.searchParams.set('pageToken', token)
          return fetch(url.toString())
        })
        .then(r => r?.json())
        .then(data => {
          if (!data?.items) return
          youtubeTokens.current.set(source.id, data.nextPageToken)
          data.items.forEach((item: any) => addMessage({
            platform: 'youtube',
            username: item.authorDetails?.displayName || 'unknown',
            channel: source.label || source.value,
            text: item.snippet?.displayMessage || '',
          }))
        }).catch(() => {})
    }
    fetchChat()
    youtubeRefs.current.set(source.id, setInterval(fetchChat, 5000))
  }

  // mint a Twitch app token via client-credentials; cached until disconnect or cred change
  const getTwitchToken = async (): Promise<string> => {
    if (twitchTokenRef.current) return twitchTokenRef.current
    const id = config.twitchClientId?.trim()
    const secret = config.twitchClientSecret?.trim()
    if (!id || !secret) return ''
    try {
      const res = await fetch(`https://id.twitch.tv/oauth2/token?client_id=${id}&client_secret=${secret}&grant_type=client_credentials`, { method: 'POST' })
      const data = await res.json()
      if (data.access_token) {
        twitchTokenRef.current = data.access_token
        return data.access_token
      }
    } catch {}
    return ''
  }

  // ---- viewer poll: parallel to chat, never touches activity chart state ----
  const pollViewers = () => {
    const gen = connectionGen.current
    config.sources.forEach(source => {
      if (source.platform === 'youtube') {
        const apiKey = config.youtubeApiKey || localStorage.getItem('yt_api_key') || ''
        if (!apiKey) return
        fetch(`https://www.googleapis.com/youtube/v3/videos?part=liveStreamingDetails&id=${source.value}&key=${apiKey}`)
          .then(r => r.json())
          .then(data => {
            if (gen !== connectionGen.current) return
            const v = data?.items?.[0]?.liveStreamingDetails?.concurrentViewers
            setViewers(prev => ({ ...prev, [source.id]: v != null ? Number(v) : null }))
          }).catch(() => {})
      }

      if (source.platform === 'kick') {
        fetch(`https://kick.com/api/v2/channels/${source.value}`)
          .then(r => r.json())
          .then(data => {
            if (gen !== connectionGen.current) return
            const v = data?.livestream?.viewer_count
            setViewers(prev => ({ ...prev, [source.id]: v != null ? Number(v) : null }))
          }).catch(() => {
            fetch(`https://kick.com/api/v1/channels/${source.value}`)
              .then(r => r.json())
              .then(data => {
                if (gen !== connectionGen.current) return
                const v = data?.livestream?.viewer_count ?? data?.livestream?.viewers
                setViewers(prev => ({ ...prev, [source.id]: v != null ? Number(v) : null }))
              }).catch(() => {})
          })
      }

      if (source.platform === 'twitch') {
        const id = config.twitchClientId?.trim()
        if (!id) return
        getTwitchToken().then(token => {
          if (!token || gen !== connectionGen.current) return
          fetch(`https://api.twitch.tv/helix/streams?user_login=${source.value.toLowerCase()}`, {
            headers: { 'Client-Id': id, 'Authorization': `Bearer ${token}` }
          })
            .then(r => r.json())
            .then(data => {
              if (gen !== connectionGen.current) return
              const v = data?.data?.[0]?.viewer_count
              setViewers(prev => ({ ...prev, [source.id]: v != null ? Number(v) : null }))
            }).catch(() => {})
        })
      }
    })
  }

  const startActivityTimer = () => {
    if (activityTimerRef.current) clearInterval(activityTimerRef.current)
    activityTimerRef.current = setInterval(() => {
      const bucket = { ...activityBucket.current }
      activityBucket.current = { twitch: 0, kick: 0, youtube: 0, x: 0 }
      const total = Object.values(bucket).reduce((a, b) => a + b, 0)
      setMsgPerMin(bucket)
      setKeywordCounts({ ...keywordCountsRef.current })
      setActivity(prev => [...prev.slice(-60), { time: Date.now(), ...bucket }])
      densityHistoryRef.current = [...densityHistoryRef.current.slice(-12), total]
      setDensityHistory([...densityHistoryRef.current])

      const avg = densityHistoryRef.current.length > 2
        ? densityHistoryRef.current.slice(-6).reduce((a, b) => a + b, 0) / Math.min(densityHistoryRef.current.length, 6)
        : 0

      if (total > avg * 2 && avg > 0) {
        const topKws = Object.entries(keywordCountsRef.current)
          .map(([text, count]) => {
            const kwDef = config.keywords.find(k => k.text === text)
            return { text, count, color: kwDef?.color || '#555' }
          })
          .sort((a, b) => b.count - a.count)
          .slice(0, 5)
        const recentMessages = messagesRef.current.slice(-30)
        setSpikeLog(prev => [...prev, {
          id: Math.random().toString(36).slice(2),
          time: Date.now(),
          timeLabel: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }),
          total,
          topKeywords: topKws,
          messages: recentMessages,
        }])
      }
    }, 5000)
  }

  const connectSource = (source: Source) => {
    if (source.platform === 'twitch') connectTwitch(source)
    if (source.platform === 'kick') connectKick(source)
    if (source.platform === 'youtube') connectYoutube(source)
  }

  const handleConnect = () => {
    config.sources.forEach(connectSource)
    if (config.sources.length > 0) setActiveStreamId(config.sources[0].id)
    setConnected(true)
    setShowConfig(false)
    startActivityTimer()
    pollViewers()
    if (viewerPollRef.current) clearInterval(viewerPollRef.current)
    viewerPollRef.current = setInterval(pollViewers, 20000)
  }

  const handleDisconnect = () => {
    connectionGen.current++
    wsRefs.current.forEach(ws => ws.close())
    wsRefs.current.clear()
    youtubeRefs.current.forEach(i => clearInterval(i))
    youtubeRefs.current.clear()
    if (activityTimerRef.current) { clearInterval(activityTimerRef.current); activityTimerRef.current = null }
    if (viewerPollRef.current) { clearInterval(viewerPollRef.current); viewerPollRef.current = null }
    setConnected(false)
    setActiveStreamId(null)
    setMessages([])
    setActivity([])
    setKeywordCounts({})
    setDensityHistory([])
    setSpikeLog([])
    setXMounted(false)
    setViewers({})
    setXOccupancy(null)
    prevAudienceRef.current = 0
    twitchTokenRef.current = ''
    keywordCountsRef.current = {}
    messagesRef.current = []
    densityHistoryRef.current = []
  }

  const addSource = () => {
    if (!newSourceValue.trim()) return
    if (newSourcePlatform === 'x' && !newSourceBroadcastId.trim()) return
    const source: Source = {
      id: Math.random().toString(36).slice(2),
      platform: newSourcePlatform,
      value: newSourceValue.trim(),
      label: newSourceLabel.trim() || undefined,
      broadcastId: newSourcePlatform === 'x' ? newSourceBroadcastId.trim() : undefined,
    }
    setConfig(p => ({ ...p, sources: [...p.sources, source] }))
    setNewSourceValue('')
    setNewSourceLabel('')
    setNewSourceBroadcastId('')
  }

  const removeSource = (id: string) => {
    const ws = wsRefs.current.get(id)
    if (ws) { ws.close(); wsRefs.current.delete(id) }
    const interval = youtubeRefs.current.get(id)
    if (interval) { clearInterval(interval); youtubeRefs.current.delete(id) }
    setConfig(p => ({ ...p, sources: p.sources.filter(s => s.id !== id) }))
    setViewers(prev => { const n = { ...prev }; delete n[id]; return n })
    if (activeStreamId === id) setActiveStreamId(null)
  }

  useEffect(() => {
    if (autoScroll && feedRef.current) {
      feedRef.current.scrollTo({ top: feedRef.current.scrollHeight, behavior: 'smooth' })
    }
  }, [messages, autoScroll])

  useEffect(() => {
    localStorage.setItem('chaggie_config_v3', JSON.stringify(config))
  }, [config])

  useEffect(() => {
    config.sources.forEach(connectSource)
    if (config.sources.length > 0) {
      setActiveStreamId(config.sources[0].id)
      setConnected(true)
    }
    startActivityTimer()
    pollViewers()
    if (viewerPollRef.current) clearInterval(viewerPollRef.current)
    viewerPollRef.current = setInterval(pollViewers, 20000)
    return () => {
      if (activityTimerRef.current) clearInterval(activityTimerRef.current)
      if (viewerPollRef.current) clearInterval(viewerPollRef.current)
    }
  }, [])

  useEffect(() => {
    const c = (window as any).chaggie
    if (c && c.getXPreloadPath) {
      c.getXPreloadPath().then((p: string) => setXPreloadPath(p)).catch(() => {})
    }
  }, [])

  const xChatSource = config.sources.find(s => s.platform === 'x')
  const xChatSrc = xChatSource && xChatSource.broadcastId
    ? `https://x.com/i/broadcasts/${xChatSource.broadcastId}`
    : ''

  useEffect(() => {
    if (xChatSource && activeStreamId) {
      const active = config.sources.find(s => s.id === activeStreamId)
      if (active?.platform === 'x') setXMounted(true)
    }
  }, [activeStreamId, xChatSource])

  useEffect(() => {
    const wv = xViewRef.current
    if (!wv || !xPreloadPath || !xChatSource) return
    const onMsg = (e: any) => {
      if (e.channel === 'x-chat') {
        const { username, text } = e.args[0]
        addMessage({ platform: 'x', username: username || 'x_user', channel: xChatSource.label || xChatSource.value || 'X', text })
      }
      if (e.channel === 'x-viewers') {
        const occ = e.args[0]?.occupancy
        if (occ != null) setXOccupancy(Number(occ))
      }
    }
    wv.addEventListener('ipc-message', onMsg)
    return () => wv.removeEventListener('ipc-message', onMsg)
  }, [xPreloadPath, xChatSource, xMounted])

  const filtered = messages.filter(m => {
    if (config.mutedUsers.includes(m.username.toLowerCase())) return false
    if (filter !== 'all' && m.platform !== filter) return false
    return true
  })

  const addKeyword = () => {
    if (keywordInput.trim()) {
      setConfig(p => ({ ...p, keywords: [...p.keywords, { text: keywordInput.trim(), color: keywordColor }] }))
      setKeywordInput('')
    }
  }

  const muteUser = (username: string) => {
    setConfig(p => ({ ...p, mutedUsers: [...p.mutedUsers, username.toLowerCase()] }))
  }

  const updateKeywordColor = (text: string, color: string) => {
    setConfig(p => ({ ...p, keywords: p.keywords.map(k => k.text === text ? { ...k, color } : k) }))
  }

  const exportCSV = () => {
    const data = spikeLog.map(s => ({
      time: s.timeLabel,
      messages: s.total,
      keywords: s.topKeywords.map(k => `${k.text}:${k.count}`).join(', ')
    }))
    const csv = ['time,messages,keywords', ...data.map(r => `${r.time},${r.messages},"${r.keywords}"`)].join('\n')
    const blob = new Blob([csv], { type: 'text/csv' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `chaggie-spikes-${new Date().toISOString().slice(0, 10)}.csv`
    a.click()
  }

  const activePlatforms = [...new Set(config.sources.map(s => s.platform))]
  const activeSource = config.sources.find(s => s.id === activeStreamId)

  const totalMsgPer5s = Object.values(msgPerMin).reduce((a, b) => a + b, 0)
  const density = getDensityLabel(totalMsgPer5s, densityHistory)
  const topKeywords = Object.entries(keywordCounts).sort((a, b) => b[1] - a[1]).slice(0, 8)
  const maxKeywordCount = Math.max(1, ...topKeywords.map(([, c]) => c))

  const totalAudience: number = Object.values(viewers).reduce((a: number, v: number | null) => a + (v || 0), 0) + (xOccupancy || 0)

  const viewerCount = (id: string): number | null => {
    const v = viewers[id]
    return typeof v === 'number' ? v : null
  }

  useEffect(() => {
    if (totalAudience > prevAudienceRef.current && prevAudienceRef.current > 0) {
      setAudiencePulse(true)
      const t = setTimeout(() => setAudiencePulse(false), 900)
      prevAudienceRef.current = totalAudience
      return () => clearTimeout(t)
    }
    prevAudienceRef.current = totalAudience
  }, [totalAudience])

  return (
    <div className="app-root">

      <div className="header">
        <div className="header-left">
          <div className="logo">
            <svg width="18" height="18" viewBox="0 0 20 20" fill="none">
              <rect x="1" y="1" width="18" height="14" rx="2" stroke="currentColor" strokeWidth="1.5"/>
              <path d="M6 15 L5 19 M14 15 L15 19 M5 19 H15" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
              <path d="M5 10 L8 7 L11 9 L15 5" stroke="#00d964" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
            CHAGGIE
          </div>
          <div className="status-bar">
            {connected ? (
              <>
                <span className="status-dot live" />
                <span className="status-text">LIVE</span>
                {activePlatforms.map(p => (
                  <span key={p} className="platform-pill" style={{ color: PLATFORM_COLORS[p], borderColor: `${PLATFORM_COLORS[p]}44` }}>
                    {PLATFORM_LABELS[p]}
                  </span>
                ))}
                <span className="platform-pill" style={{ color: '#555', borderColor: '#333' }}>{config.sources.length} SRC</span>
                {totalAudience > 0 && (
                  <span className="platform-pill" style={{ color: '#fec250', borderColor: '#fec25066' }}>
                    {totalAudience.toLocaleString()} WATCHING
                  </span>
                )}
                {xChatSource && (
                  <span className="platform-pill" style={{ color: xMounted ? PLATFORM_COLORS.x : '#7a6a70', borderColor: xMounted ? `${PLATFORM_COLORS.x}66` : '#3a2530' }}>
                    {xMounted ? 'X CHAT LIVE' : 'CLICK X TAB'}
                  </span>
                )}
              </>
            ) : (
              <>
                <span className="status-dot offline" />
                <span className="status-text muted">OFFLINE</span>
              </>
            )}
          </div>
        </div>
        <div className="header-right">
          <div className="filter-group">
            {(['all', 'twitch', 'kick', 'youtube', 'x'] as const).map(f => (
              <button key={f} onClick={() => setFilter(f)}
                className={`filter-btn ${filter === f ? 'active' : ''}`}
                style={filter === f && f !== 'all' ? { color: PLATFORM_COLORS[f as Platform], borderColor: `${PLATFORM_COLORS[f as Platform]}66` } : {}}>
                {f === 'all' ? 'ALL' : PLATFORM_LABELS[f as Platform]}
              </button>
            ))}
          </div>
          <button onClick={() => setShowSpikeLog(s => !s)} className="settings-btn"
            style={{ color: spikeLog.length > 0 ? '#ff6666' : undefined, borderColor: spikeLog.length > 0 ? '#ff444433' : undefined }}>
            {spikeLog.length} SPIKES
          </button>
          <button onClick={() => setShowConfig(s => !s)} className="settings-btn">
            {showConfig ? 'CONFIG' : 'CONFIG'}
          </button>
        </div>
      </div>

      {showConfig && (
        <div className="settings-panel">
          <div className="settings-section">
            <div className="section-label">SOURCES</div>
            <div className="source-add-row">
              <select value={newSourcePlatform} onChange={e => setNewSourcePlatform(e.target.value as Platform)}
                style={{ ...selectStyle, color: PLATFORM_COLORS[newSourcePlatform] }}>
                <option value="twitch">TWITCH</option>
                <option value="kick">KICK</option>
                <option value="youtube">YOUTUBE</option>
                <option value="x">X</option>
              </select>
              <input value={newSourceValue} onChange={e => setNewSourceValue(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && addSource()}
                placeholder={newSourcePlatform === 'youtube' ? 'video ID' : newSourcePlatform === 'x' ? 'username' : 'channel name'}
                style={{ ...inputStyle, flex: 1 }} />
              {newSourcePlatform === 'x' && (
                <input value={newSourceBroadcastId} onChange={e => setNewSourceBroadcastId(e.target.value)}
                  onKeyDown={e => e.key === 'Enter' && addSource()}
                  placeholder="broadcast ID" style={{ ...inputStyle, width: 130 }} />
              )}
              <input value={newSourceLabel} onChange={e => setNewSourceLabel(e.target.value)}
                placeholder="label" style={{ ...inputStyle, width: 80 }} />
              <button onClick={addSource} className="add-btn">ADD</button>
            </div>
            <div className="source-list">
              {config.sources.length === 0 && <div style={{ fontSize: 10, color: '#333', letterSpacing: 1 }}>No sources added</div>}
              {config.sources.map(s => (
                <div key={s.id} className="source-tag">
                  <span style={{ color: PLATFORM_COLORS[s.platform], fontSize: 9, letterSpacing: 1, minWidth: 32 }}>{PLATFORM_LABELS[s.platform]}</span>
                  <span style={{ color: '#888', fontSize: 11, flex: 1 }}>{s.label || s.value}{s.broadcastId ? ` (${s.broadcastId.slice(0, 8)})` : ''}</span>
                  <span className="remove-btn" onClick={() => removeSource(s.id)}>x</span>
                </div>
              ))}
            </div>
            <div style={{ marginTop: 8 }}>
              <div className="input-row">
                <label>YT API KEY</label>
                <input value={config.youtubeApiKey} onChange={e => setConfig(p => ({ ...p, youtubeApiKey: e.target.value }))}
                  placeholder="AIza..." style={inputStyle} type="password" />
              </div>
              <div className="input-row">
                <label>TTV CLIENT ID</label>
                <input value={config.twitchClientId || ''} onChange={e => setConfig(p => ({ ...p, twitchClientId: e.target.value }))}
                  placeholder="twitch client id" style={inputStyle} />
              </div>
              <div className="input-row">
                <label>TTV SECRET</label>
                <input value={config.twitchClientSecret || ''} onChange={e => { twitchTokenRef.current = ''; setConfig(p => ({ ...p, twitchClientSecret: e.target.value })) }}
                  placeholder="twitch secret" style={inputStyle} type="password" />
              </div>
            </div>
          </div>
          <div className="settings-section">
            <div className="section-label">SIGNALS</div>
            <div className="keyword-add-row">
              <input value={keywordInput} onChange={e => setKeywordInput(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && addKeyword()}
                placeholder="$TICKER or keyword" style={{ ...inputStyle, flex: 1 }} />
              <input type="color" value={keywordColor} onChange={e => setKeywordColor(e.target.value)} className="color-picker" />
              <button onClick={addKeyword} className="add-btn">ADD</button>
            </div>
            <div className="keyword-list">
              {config.keywords.map(k => (
                <div key={k.text} className="keyword-row">
                  <input type="color" value={k.color} onChange={e => updateKeywordColor(k.text, e.target.value)} className="color-picker small" />
                  <span className="keyword-tag" style={{ color: k.color, borderColor: `${k.color}44`, textShadow: `0 0 8px ${k.color}66` }}>{k.text}</span>
                  <span className="remove-btn" onClick={() => setConfig(p => ({ ...p, keywords: p.keywords.filter(x => x.text !== k.text) }))}>x</span>
                </div>
              ))}
            </div>
          </div>
          <div className="settings-section">
            <div className="section-label">MODERATION</div>
            <div className="keyword-add-row">
              <input value={muteInput} onChange={e => setMuteInput(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') { muteUser(muteInput); setMuteInput('') } }}
                placeholder="mute username" style={{ ...inputStyle, flex: 1 }} />
              <button onClick={() => { muteUser(muteInput); setMuteInput('') }} className="add-btn">MUTE</button>
            </div>
            {config.mutedUsers.length > 0 && (
              <div className="muted-list">
                {config.mutedUsers.map(u => (
                  <span key={u} className="muted-tag" onClick={() => setConfig(p => ({ ...p, mutedUsers: p.mutedUsers.filter(x => x !== u) }))}>
                    {u} x
                  </span>
                ))}
              </div>
            )}
          </div>
          <div className="settings-actions">
            <button onClick={handleConnect} className="connect-btn"><span className="btn-dot connect" />CONNECT</button>
            <button onClick={handleDisconnect} className="disconnect-btn"><span className="btn-dot disconnect" />DISCONNECT</button>
          </div>
        </div>
      )}

      <div className="stream-section">
        {config.sources.length === 0 ? (
          <div className="stream-empty">Add sources in CONFIG to watch streams</div>
        ) : (
          <>
            <div className="stream-tabs">
              {config.sources.map(s => (
                <button key={s.id} onClick={() => setActiveStreamId(s.id)}
                  className={`stream-tab ${activeStreamId === s.id ? 'active' : ''}`}
                  style={activeStreamId === s.id ? { color: PLATFORM_COLORS[s.platform], borderBottomColor: PLATFORM_COLORS[s.platform] } : {}}>
                  <span style={{ color: PLATFORM_COLORS[s.platform] }}>{PLATFORM_LABELS[s.platform]}</span>
                  /{s.label || s.value}
                  {viewerCount(s.id) != null && (
                    <span style={{ color: '#fec250', fontSize: 9, marginLeft: 2 }}>{viewerCount(s.id)!.toLocaleString()}</span>
                  )}
                </button>
              ))}
            </div>
            <div className="stream-player">
              {xChatSource && xChatSrc && (
                <div style={{
                  width: '100%', height: '100%', overflow: 'hidden', position: 'relative',
                  display: activeSource?.platform === 'x' ? 'block' : 'none'
                }}>
                  <webview ref={xViewRef as any} src={xChatSrc} partition="persist:xsession" preload={xPreloadPath || undefined}
                    useragent="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36"
                    style={{ position: 'absolute', top: 0, left: 0, width: '100%', minWidth: '1100px', height: '100%' }} />
                </div>
              )}
              {activeSource && activeSource.platform !== 'x' && (
                <iframe src={getStreamEmbedUrl(activeSource)} style={{ width: '100%', height: '100%', border: 'none' }} allowFullScreen allow="autoplay; fullscreen" />
              )}
              {!activeSource && <div className="stream-empty">Select a stream tab</div>}
            </div>
          </>
        )}
      </div>

      <div className="bottom-section">

        <div className="activity-panel">
          <div className="panel-label">CHAT ACTIVITY</div>
          <div className="activity-graph">
            <ActivityGraph data={activity} height={70} />
          </div>
          <div style={{
            display: 'flex', alignItems: 'center', justifyContent: 'space-between',
            padding: '4px 8px', borderRadius: 4,
            border: `1px solid ${audiencePulse ? '#00d96499' : '#fec25044'}`,
            background: audiencePulse ? '#00d96418' : '#fec25011',
            transition: 'all 0.4s ease', flexShrink: 0
          }}>
            <span style={{ color: audiencePulse ? '#00d964' : '#fec250', fontSize: 9, letterSpacing: 1, transition: 'color 0.4s ease' }}>WATCHING</span>
            <span style={{ color: audiencePulse ? '#00d964' : '#fec250', fontSize: 13, fontWeight: 700, transition: 'color 0.4s ease' }}>{totalAudience.toLocaleString()}</span>
          </div>
          <div className="density-badge" style={{ borderColor: `${density.color}44`, background: `${density.color}11` }}>
            <span style={{ color: density.color, fontSize: 10, fontWeight: 600, letterSpacing: 2 }}>{density.label}</span>
          </div>
          <div className="activity-stats">
            <div className="stat-row">
              <span style={{ color: '#444', fontSize: 9, letterSpacing: 1 }}>MSG/5S</span>
              <span style={{ color: '#ccc', fontSize: 12, fontWeight: 600 }}>{totalMsgPer5s}</span>
            </div>
            {(['twitch', 'kick', 'youtube', 'x'] as Platform[]).map(p => {
              const platViewers: number = config.sources
                .filter(s => s.platform === p)
                .reduce((a: number, s) => a + (viewerCount(s.id) || 0), 0) + (p === 'x' ? (xOccupancy || 0) : 0)
              return (
                <div key={p} className="stat-row">
                  <span style={{ color: PLATFORM_COLORS[p], fontSize: 9, letterSpacing: 1 }}>{PLATFORM_LABELS[p]}</span>
                  <span style={{ display: 'flex', gap: 8, alignItems: 'baseline' }}>
                    {platViewers > 0 && <span style={{ color: '#fec25099', fontSize: 9 }}>{platViewers.toLocaleString()}</span>}
                    <span style={{ color: PLATFORM_COLORS[p], fontSize: 11 }}>{msgPerMin[p]}</span>
                  </span>
                </div>
              )
            })}
          </div>
          <div className="panel-label" style={{ marginTop: 8 }}>SIGNALS</div>
          <div className="keyword-freq-list">
            {topKeywords.length === 0 && <div style={{ fontSize: 9, color: '#2a2a2a' }}>No mentions yet</div>}
            {topKeywords.map(([kw, count]) => {
              const kwDef = config.keywords.find(k => k.text === kw)
              const color = kwDef?.color || '#555'
              const pct = (count / maxKeywordCount) * 100
              return (
                <div key={kw} className="kw-freq-row">
                  <span style={{ color, fontSize: 9, fontWeight: 600, minWidth: 44, letterSpacing: 1 }}>{kw}</span>
                  <div className="kw-bar-track">
                    <div className="kw-bar-fill" style={{ width: `${pct}%`, background: color, boxShadow: `0 0 4px ${color}88` }} />
                  </div>
                  <span style={{ color, fontSize: 9, minWidth: 20, textAlign: 'right' }}>{count}</span>
                </div>
              )
            })}
          </div>
          <div className="legend">
            {(['twitch', 'kick', 'youtube', 'x'] as Platform[]).map(p => (
              <div key={p} className="legend-item">
                <span style={{ background: PLATFORM_COLORS[p] }} className="legend-dot" />
                <span style={{ color: '#444', fontSize: 9 }}>{PLATFORM_LABELS[p]}</span>
              </div>
            ))}
          </div>
        </div>

        <div className="chat-panel">
          <div ref={feedRef} className="chat-feed"
            onMouseEnter={() => setAutoScroll(false)}
            onMouseLeave={() => {
              if (feedRef.current) {
                const el = feedRef.current
                if (el.scrollHeight - el.scrollTop - el.clientHeight < 80) setAutoScroll(true)
              }
            }}
            onWheel={() => setAutoScroll(false)}>
            {filtered.length === 0 && (
              <div className="empty-state">
                <svg width="28" height="28" viewBox="0 0 20 20" fill="none" opacity="0.15">
                  <rect x="1" y="1" width="18" height="14" rx="2" stroke="white" strokeWidth="1.5"/>
                  <path d="M5 10 L8 7 L11 9 L15 5" stroke="white" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
                </svg>
                <span>Add sources and hit CONNECT</span>
              </div>
            )}
            {filtered.map(msg => {
              const isHighlighted = msg.matchedKeywords && msg.matchedKeywords.length > 0
              const highlightColor = isHighlighted ? msg.matchedKeywords![0].color : null
              return (
                <div key={msg.id} className={`chat-row ${isHighlighted ? 'highlighted' : ''}`}
                  style={isHighlighted ? { borderLeftColor: highlightColor!, background: `${highlightColor}09` } : {}}>
                  <span className="platform-label" style={{ color: PLATFORM_COLORS[msg.platform] }}>
                    {PLATFORM_LABELS[msg.platform]}{msg.channel ? `/${msg.channel}` : ''}
                  </span>
                  <span className="chat-username" style={{ color: PLATFORM_COLORS[msg.platform] }}
                    title="click to mute" onClick={() => muteUser(msg.username)}>
                    {msg.username}
                  </span>
                  <span className="chat-text">{highlightText(msg.text, config.keywords)}</span>
                  <span className="chat-time">
                    {msg.timestamp.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
                  </span>
                </div>
              )
            })}
          </div>
          <div className="footer">
            <span className="msg-count">{filtered.length} MSG</span>
            <div className="ticker-divider" />
            <span className="autoscroll-toggle" onClick={() => {
              setAutoScroll(true)
              if (feedRef.current) feedRef.current.scrollTo({ top: feedRef.current.scrollHeight, behavior: 'smooth' })
            }}
              style={{ color: autoScroll ? '#00d964' : '#ff9944' }}>
              {autoScroll ? 'LIVE' : 'RESUME'}
            </span>
          </div>
        </div>

        <div className="controls-panel">
          <div className="panel-label">SOURCES</div>
          <div className="controls-sources">
            {config.sources.length === 0 && <div style={{ fontSize: 10, color: '#2a2a2a' }}>No sources</div>}
            {config.sources.map(s => (
              <div key={s.id} className={`control-source-row ${activeStreamId === s.id ? 'active-source' : ''}`}
                onClick={() => setActiveStreamId(s.id)}>
                <span style={{ color: PLATFORM_COLORS[s.platform], fontSize: 9, letterSpacing: 1 }}>{PLATFORM_LABELS[s.platform]}</span>
                <span style={{ color: '#777', fontSize: 11, flex: 1 }}>{s.label || s.value}</span>
                {viewerCount(s.id) != null && (
                  <span style={{ color: '#fec25099', fontSize: 9 }}>{viewerCount(s.id)!.toLocaleString()}</span>
                )}
                <span className="status-dot" style={{
                  background: connected ? PLATFORM_COLORS[s.platform] : '#222',
                  boxShadow: connected ? `0 0 4px ${PLATFORM_COLORS[s.platform]}88` : 'none'
                }} />
              </div>
            ))}
          </div>
          <div className="panel-label" style={{ marginTop: 10 }}>KEYWORDS</div>
          <div className="controls-keywords">
            {config.keywords.map(k => (
              <div key={k.text} className="control-keyword">
                <span style={{ color: k.color, fontSize: 10, fontWeight: 600, textShadow: `0 0 6px ${k.color}88` }}>{k.text}</span>
                <span style={{ color: '#333', fontSize: 9 }}>{keywordCounts[k.text] || 0}</span>
              </div>
            ))}
          </div>
          <div style={{ marginTop: 'auto', display: 'flex', flexDirection: 'column', gap: 5 }}>
            <button onClick={() => setShowConfig(s => !s)} className="settings-btn" style={{ width: '100%', textAlign: 'center' }}>
              CONFIG
            </button>
            {connected ? (
              <button onClick={handleDisconnect} className="disconnect-btn" style={{ width: '100%' }}>
                <span className="btn-dot disconnect" />DISCONNECT
              </button>
            ) : (
              <button onClick={handleConnect} className="connect-btn" style={{ width: '100%' }}>
                <span className="btn-dot connect" />CONNECT
              </button>
            )}
          </div>
        </div>
      </div>

      {showSpikeLog && (
        <div className="spike-log-overlay">
          <div className="spike-log-panel">
            <div className="spike-log-header">
              <span style={{ color: '#ff6666', letterSpacing: 2, fontSize: 11, fontWeight: 600 }}>SPIKE LOG</span>
              <div style={{ display: 'flex', gap: 8 }}>
                <button onClick={exportCSV} className="add-btn">EXPORT CSV</button>
                <button onClick={() => setShowSpikeLog(false)} className="close-btn">X</button>
              </div>
            </div>
            <div className="spike-log-list">
              {spikeLog.length === 0 && <div style={{ color: '#333', fontSize: 11, padding: 12 }}>No spikes detected yet</div>}
              {spikeLog.map(spike => (
                <div key={spike.id} className={`spike-row ${selectedSpike?.id === spike.id ? 'selected' : ''}`}
                  onClick={() => setSelectedSpike(selectedSpike?.id === spike.id ? null : spike)}>
                  <div className="spike-row-header">
                    <span style={{ color: '#ff6666', fontSize: 11, fontWeight: 600 }}>{spike.timeLabel}</span>
                    <span style={{ color: '#555', fontSize: 10 }}>{spike.total} msg/5s</span>
                  </div>
                  {spike.topKeywords.length > 0 && (
                    <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', marginTop: 3 }}>
                      {spike.topKeywords.map(k => (
                        <span key={k.text} style={{ color: k.color, fontSize: 9, border: `1px solid ${k.color}44`, padding: '1px 4px', borderRadius: 2 }}>
                          {k.text} {k.count}
                        </span>
                      ))}
                    </div>
                  )}
                  {selectedSpike?.id === spike.id && (
                    <div className="spike-messages">
                      {spike.messages.map(m => (
                        <div key={m.id} style={{ fontSize: 10, color: '#555', padding: '2px 0', borderBottom: '1px solid #141414' }}>
                          <span style={{ color: PLATFORM_COLORS[m.platform], marginRight: 6 }}>{PLATFORM_LABELS[m.platform]}</span>
                          <span style={{ color: '#777', marginRight: 6 }}>{m.username}</span>
                          <span>{m.text}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

const inputStyle: React.CSSProperties = {
  background: '#0d0d0d', border: '1px solid #2a2a2a', color: '#d0d0d0',
  padding: '5px 8px', borderRadius: 3, fontSize: 12, outline: 'none', fontFamily: 'inherit',
}

const selectStyle: React.CSSProperties = {
  background: '#0d0d0d', border: '1px solid #2a2a2a', color: '#d0d0d0',
  padding: '5px 8px', borderRadius: 3, fontSize: 11, outline: 'none',
  fontFamily: 'inherit', letterSpacing: 1, cursor: 'pointer',
}