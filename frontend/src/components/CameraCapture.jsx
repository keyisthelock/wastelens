import { useEffect, useRef, useState } from 'react'
import { Camera, Check, RefreshCw, X } from 'lucide-react'

const stopStream = (stream) => stream?.getTracks().forEach((track) => track.stop())
const cameraMessage = (error) => {
  if (['NotAllowedError', 'PermissionDeniedError'].includes(error?.name)) return 'Camera permission was denied. Allow camera access in your browser settings, or choose an existing photo.'
  if (['NotFoundError', 'DevicesNotFoundError'].includes(error?.name)) return 'No camera was found. You can still choose a photo from your device.'
  if (['NotReadableError', 'TrackStartError'].includes(error?.name)) return 'The camera is busy or unavailable. Close other camera apps and try again.'
  return 'The camera could not open. Try again or choose an existing photo.'
}

export default function CameraCapture({ onCapture, disabled = false }) {
  const [open, setOpen] = useState(false)
  const [phase, setPhase] = useState('idle')
  const [error, setError] = useState('')
  const [photo, setPhoto] = useState(null)
  const [preview, setPreview] = useState('')
  const [cameraReady, setCameraReady] = useState(false)
  const video = useRef(null)
  const stream = useRef(null)
  const attempt = useRef(0)
  const mounted = useRef(true)
  const captureBusy = useRef(false)

  const stop = () => {
    attempt.current += 1
    stopStream(stream.current); stream.current = null
    if (video.current) video.current.srcObject = null
  }
  const close = () => {
    stop(); setOpen(false); setPhase('idle'); setPhoto(null); setError('')
  }
  const start = async () => {
    if (disabled) return
    stop(); setOpen(true); setError(''); setPhoto(null); setCameraReady(false); setPhase('starting')
    const request = attempt.current
    if (!window.isSecureContext) {
      setPhase('error'); setError('Camera access needs HTTPS or localhost. Choose a photo here, or open the secure WasteLens website.'); return
    }
    if (!navigator.mediaDevices?.getUserMedia) {
      setPhase('error'); setError('This browser cannot show a live camera. Use the device camera option below or choose an existing photo.'); return
    }
    try {
      const live = await navigator.mediaDevices.getUserMedia({
        audio: false, video: { facingMode: { ideal: 'environment' }, width: { ideal: 1600 }, height: { ideal: 1200 } },
      })
      if (!mounted.current || request !== attempt.current) { stopStream(live); return }
      stream.current = live
      for (const track of live.getVideoTracks()) {
        track.addEventListener('ended', () => {
          if (mounted.current && request === attempt.current) {
            stop(); setPhase('error'); setError('The camera disconnected. Try again or choose an existing photo.')
          }
        }, { once: true })
      }
      setPhase('live')
    } catch (e) {
      if (mounted.current && request === attempt.current) { setError(cameraMessage(e)); setPhase('error') }
    }
  }
  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false; attempt.current += 1; stopStream(stream.current); stream.current = null }
  }, [])
  useEffect(() => {
    if (!photo) { setPreview(''); return undefined }
    const url = URL.createObjectURL(photo); setPreview(url)
    return () => URL.revokeObjectURL(url)
  }, [photo])
  useEffect(() => {
    if (phase !== 'live' || !video.current || !stream.current) return undefined
    const active = video.current
    const request = attempt.current
    active.srcObject = stream.current
    active.play().catch(() => {
      if (mounted.current && request === attempt.current) {
        stop(); setPhase('error'); setError('Camera preview could not start. Try again or use the device camera option below.')
      }
    })
    return () => { active.srcObject = null }
  }, [phase])
  useEffect(() => {
    if (!open) return undefined
    const leave = () => {
      stop(); setPhase('error'); setPhoto(null)
      setError('Camera stopped when you left this page. Tap Try camera again to reopen it.')
    }
    const visibility = () => { if (document.visibilityState === 'hidden') leave() }
    const escape = (event) => { if (event.key === 'Escape') close() }
    document.addEventListener('visibilitychange', visibility)
    window.addEventListener('pagehide', leave)
    window.addEventListener('keydown', escape)
    return () => {
      document.removeEventListener('visibilitychange', visibility)
      window.removeEventListener('pagehide', leave)
      window.removeEventListener('keydown', escape)
    }
  }, [open])
  useEffect(() => { if (disabled && open) close() }, [disabled])

  const snap = async () => {
    if (captureBusy.current || !video.current?.videoWidth) return
    captureBusy.current = true; setError('')
    const request = attempt.current
    try {
      const active = video.current
      const scale = Math.min(1, 1600 / Math.max(active.videoWidth, active.videoHeight))
      const canvas = document.createElement('canvas')
      canvas.width = Math.max(1, Math.round(active.videoWidth * scale))
      canvas.height = Math.max(1, Math.round(active.videoHeight * scale))
      const context = canvas.getContext('2d', { alpha: false })
      if (!context) throw new Error('Photo capture is unavailable in this browser.')
      context.drawImage(active, 0, 0, canvas.width, canvas.height)
      const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.88))
      if (!blob) throw new Error('The photo could not be captured. Please try again.')
      if (!mounted.current || request !== attempt.current) return
      const captured = new File([blob], `wastelens-camera-${Date.now()}.jpg`, { type: 'image/jpeg' })
      stop(); setPhoto(captured); setPhase('review')
    } catch (e) { if (mounted.current && request === attempt.current) setError(e.message) }
    finally { captureBusy.current = false }
  }
  const usePhoto = () => {
    if (!photo || disabled) return
    onCapture(photo); close()
  }
  return <div className="camera-capture">
    {!open ? <button type="button" className="button button-outline camera-open" disabled={disabled} onClick={start}><Camera size={16}/> Take a photo</button> : <section className="camera-panel" aria-label="Take a waste photo">
      <div className="camera-heading"><div><b>{phase === 'review' ? 'How does it look?' : 'Capture your sighting'}</b><small>{phase === 'review' ? 'Review it before using it.' : 'Point your camera at the waste.'}</small></div><button type="button" className="icon-button" onClick={close} aria-label="Close camera"><X size={18}/></button></div>
      {phase === 'starting' && <p className="camera-status" role="status"><span className="button-loader"/> Opening camera… Allow access if your browser asks.</p>}
      {phase === 'live' && <video ref={video} autoPlay muted playsInline onCanPlay={() => setCameraReady(true)} className="camera-preview" aria-label="Live camera preview"/>}
      {phase === 'review' && preview && <img src={preview} className="camera-preview" alt="Captured waste photo preview"/>}
      {error && <p className="tool-error" role="alert">{error}</p>}
      <div className="camera-actions">
        {phase === 'live' && <button type="button" className="button button-green" disabled={!cameraReady} onClick={snap}><Camera size={16}/> {cameraReady ? 'Capture photo' : 'Preparing camera…'}</button>}
        {phase === 'review' && <><button type="button" className="button button-outline" onClick={start}><RefreshCw size={15}/> Retake</button><button type="button" className="button button-green" onClick={usePhoto}><Check size={15}/> Use this photo</button></>}
        {phase === 'error' && <><button type="button" className="button button-outline" onClick={start}>Try camera again</button><label className="button button-green native-camera">Open device camera<input type="file" accept="image/*" capture="environment" onChange={(event) => { const file = event.target.files?.[0]; if (file) { onCapture(file); close() } event.target.value = '' }}/></label></>}
        {phase === 'starting' && <button type="button" className="button button-outline" onClick={close}>Cancel</button>}
      </div>
      <p className="camera-privacy">No audio is recorded. The photo stays on your device until you submit the report or request analysis.</p>
    </section>}
  </div>
}
