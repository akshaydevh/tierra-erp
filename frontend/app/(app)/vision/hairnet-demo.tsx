'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import type { HairnetCheck, HairnetCheckResponse, HairnetVerdict } from '@/lib/types'

/** Long edge of frames sent for checking: enough to see thin mesh, without paying for a full-size image. */
const MAX_FRAME_EDGE = 1280
const INTERVALS_SEC = [2, 5, 10, 30]
const HISTORY_LENGTH = 12
/** The first frame after the camera starts is often dark while it adjusts exposure. */
const WARM_UP_MS = 800

type Tone = 'ok' | 'coral' | 'amber' | 'grey'

const VERDICTS: Record<HairnetVerdict, { title: string; tone: Tone }> = {
  wearing: { title: 'Hairnet on', tone: 'ok' },
  not_wearing: { title: 'No hairnet', tone: 'coral' },
  uncertain: { title: "Can't tell", tone: 'amber' },
  no_person: { title: 'No one in frame', tone: 'grey' },
}

const HEADWEAR: Record<HairnetCheck['headwear'], string> = {
  hairnet: 'hairnet',
  bouffant_cap: 'bouffant cap',
  other_headwear: 'other headwear',
  none: 'no headwear',
  not_visible: 'head',
}

// The canvas can't read CSS variables; these are brighter cuts of --leafink, --coral, --amber and --mute so they show on video.
const TONE_HEX: Record<Tone, string> = { ok: '#2fa865', coral: '#e0503f', amber: '#e08a1e', grey: '#a3ad9e' }

type Checked = HairnetCheckResponse & { id: number; at: number }

function toneOf(check: HairnetCheck): Tone {
  if (check.verdict === 'wearing' && check.hairFullyCovered === false) return 'amber'
  return VERDICTS[check.verdict].tone
}

function titleOf(check: HairnetCheck): string {
  if (check.verdict === 'wearing' && check.hairFullyCovered === false) return 'Hairnet on, hair escaping'
  return VERDICTS[check.verdict].title
}

function clock(at: number): string {
  return new Date(at).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

/** The current video frame as a JPEG data URL, downscaled so the long edge is at most MAX_FRAME_EDGE. */
function captureFrame(video: HTMLVideoElement): string {
  const scale = Math.min(1, MAX_FRAME_EDGE / Math.max(video.videoWidth, video.videoHeight))
  const canvas = document.createElement('canvas')
  canvas.width = Math.round(video.videoWidth * scale)
  canvas.height = Math.round(video.videoHeight * scale)
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('This browser cannot capture a frame.')
  ctx.drawImage(video, 0, 0, canvas.width, canvas.height)
  return canvas.toDataURL('image/jpeg', 0.85)
}

/**
 * The head box over the video. The preview is mirrored with CSS, so the box is flipped here instead of
 * mirroring the canvas (which would mirror the label too).
 */
function drawHeadBox(canvas: HTMLCanvasElement, video: HTMLVideoElement, check: HairnetCheck, mirrored: boolean) {
  canvas.width = video.videoWidth
  canvas.height = video.videoHeight
  const ctx = canvas.getContext('2d')
  if (!ctx) return
  ctx.clearRect(0, 0, canvas.width, canvas.height)
  const box = check.headBox
  if (!box) return

  const color = TONE_HEX[toneOf(check)]
  const width = box.width * canvas.width
  const height = box.height * canvas.height
  const left = (mirrored ? 1 - box.x - box.width : box.x) * canvas.width
  const top = box.y * canvas.height
  const stroke = Math.max(2, Math.round(canvas.width / 320))
  ctx.lineWidth = stroke
  ctx.lineJoin = 'round'
  ctx.strokeStyle = color
  ctx.strokeRect(left, top, width, height)

  const label = HEADWEAR[check.headwear]
  const size = Math.max(12, Math.round(canvas.width / 55))
  ctx.font = `600 ${size}px ui-sans-serif, system-ui, sans-serif`
  ctx.textBaseline = 'bottom'
  const pad = stroke * 2
  const labelTop = Math.max(0, top - size - pad * 2)
  ctx.fillStyle = color
  ctx.fillRect(left - stroke / 2, labelTop, ctx.measureText(label).width + pad * 2, size + pad * 2)
  ctx.fillStyle = '#ffffff'
  ctx.fillText(label, left + pad - stroke / 2, labelTop + size + pad)
}

async function sendFrame(image: string, signal: AbortSignal): Promise<HairnetCheckResponse> {
  const response = await fetch('/api/vision/hairnet', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ image }),
    signal,
  })
  const body = (await response.json().catch(() => null)) as (HairnetCheckResponse & { error?: string }) | null
  if (response.status === 401) throw new Error('Your session has ended. Sign in again.')
  if (!response.ok || !body) throw new Error(body?.error ?? `The check failed (${response.status}).`)
  return body
}

export function HairnetDemo({ configured, model }: { configured: boolean; model: string | null }) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const overlayRef = useRef<HTMLCanvasElement>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const requestRef = useRef<AbortController | null>(null)
  const seqRef = useRef(0)

  const [cameras, setCameras] = useState<MediaDeviceInfo[]>([])
  const [cameraId, setCameraId] = useState('')
  const [starting, setStarting] = useState(false)
  const [cameraReady, setCameraReady] = useState(false)
  const [aspect, setAspect] = useState(16 / 9)
  const [mirrored, setMirrored] = useState(true)
  const [live, setLive] = useState(false)
  const [intervalSec, setIntervalSec] = useState(5)
  const [busy, setBusy] = useState(false)
  const [history, setHistory] = useState<Checked[]>([])
  const [error, setError] = useState('')
  const [now, setNow] = useState(() => Date.now())

  const latest = history[0] ?? null

  useEffect(() => {
    return () => {
      requestRef.current?.abort()
      streamRef.current?.getTracks().forEach((track) => track.stop())
    }
  }, [])

  // Ticks the "checked Ns ago" label, so an old verdict is never taken for a current one.
  useEffect(() => {
    if (!cameraReady) return
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [cameraReady])

  useEffect(() => {
    const canvas = overlayRef.current
    const video = videoRef.current
    if (!canvas || !video) return
    if (!latest || !cameraReady) {
      canvas.getContext('2d')?.clearRect(0, 0, canvas.width, canvas.height)
      return
    }
    drawHeadBox(canvas, video, latest.check, mirrored)
  }, [latest, mirrored, cameraReady])

  /** Captures one frame and checks it. False when the check failed or a newer one replaced it. */
  const runCheck = useCallback(async (): Promise<boolean> => {
    const video = videoRef.current
    if (!video?.videoWidth) return false
    requestRef.current?.abort()
    const controller = new AbortController()
    requestRef.current = controller
    setBusy(true)
    try {
      const result = await sendFrame(captureFrame(video), controller.signal)
      setHistory((previous) => [{ ...result, id: ++seqRef.current, at: Date.now() }, ...previous].slice(0, HISTORY_LENGTH))
      setError('')
      return true
    } catch (caught) {
      if (controller.signal.aborted) return false
      setError(caught instanceof Error ? caught.message : 'The check failed.')
      setLive(false)
      return false
    } finally {
      if (requestRef.current === controller) {
        requestRef.current = null
        setBusy(false)
      }
    }
  }, [])

  async function startCamera(deviceId?: string): Promise<boolean> {
    setError('')
    if (!navigator.mediaDevices?.getUserMedia) {
      setError('The camera needs a secure page: open Tierra on https or localhost.')
      return false
    }
    setStarting(true)
    streamRef.current?.getTracks().forEach((track) => track.stop())
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          ...(deviceId ? { deviceId: { exact: deviceId } } : { facingMode: 'user' }),
          width: { ideal: 1280 },
          height: { ideal: 720 },
        },
        audio: false,
      })
      streamRef.current = stream
      const video = videoRef.current
      if (!video) {
        stream.getTracks().forEach((track) => track.stop())
        return false
      }
      video.srcObject = stream
      await video.play()
      setAspect(video.videoWidth / video.videoHeight || 16 / 9)
      setCameraReady(true)
      // Camera names are only shown after permission is granted.
      const devices = await navigator.mediaDevices.enumerateDevices()
      setCameras(devices.filter((device) => device.kind === 'videoinput'))
      setCameraId(stream.getVideoTracks()[0]?.getSettings().deviceId ?? '')
      return true
    } catch (caught) {
      streamRef.current?.getTracks().forEach((track) => track.stop())
      streamRef.current = null
      setCameraReady(false)
      const denied = caught instanceof DOMException && caught.name === 'NotAllowedError'
      setError(
        denied
          ? 'Camera permission was denied. Allow the camera for this site in the browser, then try again.'
          : 'Could not start the camera. Check that no other app is using it.',
      )
      return false
    } finally {
      setStarting(false)
    }
  }

  /** The demo button: start the camera, give it a moment to settle, then check one frame. */
  async function testVision() {
    if (!(await startCamera())) return
    await new Promise((resolve) => window.setTimeout(resolve, WARM_UP_MS))
    await runCheck()
  }

  function stopCamera() {
    setLive(false)
    requestRef.current?.abort()
    streamRef.current?.getTracks().forEach((track) => track.stop())
    streamRef.current = null
    if (videoRef.current) videoRef.current.srcObject = null
    setCameraReady(false)
  }

  // Live: check, wait the interval after the answer, repeat. Never more than one request in flight.
  useEffect(() => {
    if (!live || !cameraReady) return
    let cancelled = false
    let timer: number | undefined
    const tick = async () => {
      const ok = await runCheck()
      if (ok && !cancelled) timer = window.setTimeout(tick, intervalSec * 1000)
    }
    timer = window.setTimeout(tick, 0)
    return () => {
      cancelled = true
      window.clearTimeout(timer)
      requestRef.current?.abort()
    }
  }, [live, cameraReady, intervalSec, runCheck])

  const tone: Tone | 'idle' = latest ? toneOf(latest.check) : 'idle'
  const ageSec = latest ? Math.max(0, Math.round((now - latest.at) / 1000)) : 0
  const stale = latest !== null && (error !== '' || ageSec > Math.max(15, intervalSec * 3))

  return (
    <div className="cv">
      <div className="cvstage">
        <div className="cvview" style={{ aspectRatio: aspect }}>
          <video ref={videoRef} className={mirrored ? 'mirrored' : undefined} autoPlay muted playsInline />
          <canvas ref={overlayRef} className="cvoverlay" />
          {cameraReady ? (
            <span className={live ? 'cvlive on' : 'cvlive'}>
              <i aria-hidden="true" />
              {live ? `Live · every ${intervalSec}s` : 'Paused'}
            </span>
          ) : (
            <div className="cvstart">
              <svg className="cvicon" viewBox="0 0 256 256" aria-hidden="true">
                <path d="M32 88h40l16-24h80l16 24h40v120H32zM128 176a28 28 0 1 0-0.1 0" />
              </svg>
              <button type="button" className="btn-pri" onClick={() => void testVision()} disabled={!configured || starting}>
                {starting ? 'Starting camera…' : 'Test computer vision'}
              </button>
              <p>
                {configured
                  ? 'Your browser will ask to use the camera. Frames leave this computer only when a check runs.'
                  : 'Computer vision is off: the server needs an OpenAI key (OPENAI_API_KEY).'}
              </p>
            </div>
          )}
        </div>
        {cameraReady ? (
          <div className={`cvverdict ${tone}${stale ? ' stale' : ''}`} role="status" aria-live="polite">
            <div>
              <b>{latest ? `${stale ? 'Last: ' : ''}${titleOf(latest.check)}` : busy ? 'Checking…' : 'Ready'}</b>
              {latest ? <span>{latest.check.reason}</span> : null}
            </div>
            {busy ? <span className="cvspin" aria-label="Checking" /> : null}
            {latest && !busy ? <small>{ageSec < 2 ? 'just now' : `${ageSec}s ago`}</small> : null}
          </div>
        ) : null}
        {error ? (
          <p className="formerror" role="alert">
            {error}
          </p>
        ) : null}
      </div>

      <aside className="cvpanel">
        <div className="card p6 cvgroup">
          <button type="button" className="btn-pri" onClick={() => void runCheck()} disabled={!cameraReady || busy || live}>
            {busy && !live ? 'Checking…' : 'Check now'}
          </button>
          <div className="cvrow">
            <button
              type="button"
              className={live ? 'btn-danger' : 'btn-sec'}
              onClick={() => setLive((on) => !on)}
              disabled={!cameraReady}
            >
              {live ? 'Stop live' : 'Start live'}
            </button>
            <select aria-label="Live interval" value={intervalSec} onChange={(event) => setIntervalSec(Number(event.target.value))}>
              {INTERVALS_SEC.map((sec) => (
                <option key={sec} value={sec}>
                  every {sec}s
                </option>
              ))}
            </select>
          </div>
          {cameras.length > 1 ? (
            <label className="cvfield">
              <span>Camera</span>
              <select value={cameraId} onChange={(event) => void startCamera(event.target.value)}>
                {cameras.map((camera, index) => (
                  <option key={camera.deviceId} value={camera.deviceId}>
                    {camera.label || `Camera ${index + 1}`}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
          <div className="cvrow">
            <label className="cvcheck">
              <input type="checkbox" checked={mirrored} onChange={(event) => setMirrored(event.target.checked)} />
              Mirror preview
            </label>
            {cameraReady ? (
              <button type="button" className="linkbtn" onClick={stopCamera}>
                Stop camera
              </button>
            ) : null}
          </div>
        </div>

        {latest ? (
          <dl className="card p6 facts cvfacts">
            <div>
              <dt>Confidence</dt>
              <dd className="num">{Math.round(latest.check.confidence * 100)}%</dd>
            </div>
            <div>
              <dt>Hair covered</dt>
              <dd>{latest.check.hairFullyCovered === null ? 'n/a' : latest.check.hairFullyCovered ? 'Yes' : 'No'}</dd>
            </div>
            <div>
              <dt>People</dt>
              <dd className="num">{latest.check.peopleCount}</dd>
            </div>
            <div>
              <dt>Took</dt>
              <dd className="num">{(latest.latencyMs / 1000).toFixed(1)}s</dd>
            </div>
          </dl>
        ) : null}

        <div className="card p6 cvgroup">
          <b className="cvhead">Recent checks</b>
          {history.length === 0 ? (
            <p className="muted">No checks yet.</p>
          ) : (
            <ol className="cvhistory">
              {history.map((entry) => (
                <li key={entry.id}>
                  <span className={`pill ${toneOf(entry.check)}`}>{titleOf(entry.check)}</span>
                  <span className="stamp">
                    {clock(entry.at)} · {(entry.latencyMs / 1000).toFixed(1)}s
                  </span>
                </li>
              ))}
            </ol>
          )}
        </div>

        <p className="stamp">A model&apos;s verdict is not a compliance record. Check it against what you see.</p>
      </aside>
    </div>
  )
}
