"use client"

import React, { useState, useEffect, useRef, useCallback } from 'react'
import { Dialog, DialogContent } from './ui/dialog'
import { Button } from './ui/button'
import { Slider } from './ui/slider'
import { 
  X, 
  Play, 
  Pause, 
  RotateCcw,
  Maximize,
  Settings,
  ChevronUp,
  ChevronDown
} from 'lucide-react'
import { cn } from '@/lib/utils'

interface FullScreenPDFViewerProps {
  pdfUrl: string
  isOpen: boolean
  onClose: () => void
  title?: string
  subtitle?: string
}

export function FullScreenPDFViewer({ 
  pdfUrl, 
  isOpen, 
  onClose, 
  title, 
  subtitle 
}: FullScreenPDFViewerProps) {
  const [isPlaying, setIsPlaying] = useState(false)
  const [scrollSpeed, setScrollSpeed] = useState(1) // pixels per 100ms
  const [showControls, setShowControls] = useState(true)
  const [isSettingsOpen, setIsSettingsOpen] = useState(false)
  const [isHoveringControls, setIsHoveringControls] = useState(false)
  const iframeRef = useRef<HTMLIFrameElement>(null)
  const scrollIntervalRef = useRef<NodeJS.Timeout | null>(null)
  const hideControlsTimeoutRef = useRef<NodeJS.Timeout | null>(null)
  const lastMouseMoveRef = useRef(Date.now())
  const containerRef = useRef<HTMLDivElement>(null)

  // Auto-hide controls after inactivity
  const resetHideControlsTimer = useCallback(() => {
    if (hideControlsTimeoutRef.current) {
      clearTimeout(hideControlsTimeoutRef.current)
    }
    
    setShowControls(true)
    lastMouseMoveRef.current = Date.now()
    
    hideControlsTimeoutRef.current = setTimeout(() => {
      const timeSinceLastMove = Date.now() - lastMouseMoveRef.current
      // Don't hide controls if:
      // 1. Settings panel is open
      // 2. User is hovering over controls
      // 3. Not enough time has passed
      if (timeSinceLastMove >= 2500 && !isSettingsOpen && !isHoveringControls) {
        setShowControls(false)
      }
    }, 2500) // Reduced from 3000ms to 2.5s for faster hiding
  }, [isSettingsOpen, isHoveringControls])

  // Handle mouse movement to show controls
  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    resetHideControlsTimer()
    
    // Check if mouse is near the edges where controls are located
    const rect = containerRef.current?.getBoundingClientRect()
    if (rect) {
      const { top, bottom, left, right } = rect
      const mouseY = e.clientY
      const mouseX = e.clientX
      
      // Show controls if mouse is near top (80px) or bottom (120px) of screen
      const nearTop = mouseY - top < 80
      const nearBottom = bottom - mouseY < 120
      const inBounds = mouseX >= left && mouseX <= right
      
      if ((nearTop || nearBottom) && inBounds) {
        setShowControls(true)
      }
    }
  }, [resetHideControlsTimer])

  // Keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (!isOpen) return
      
      switch (e.key) {
        case 'Escape':
          onClose()
          break
        case ' ':
        case 'k':
          e.preventDefault()
          togglePlay()
          break
        case 'ArrowUp':
          e.preventDefault()
          adjustSpeed(0.5)
          break
        case 'ArrowDown':
          e.preventDefault()
          adjustSpeed(-0.5)
          break
        case 'r':
          e.preventDefault()
          resetToTop()
          break
        case 's':
          e.preventDefault()
          setIsSettingsOpen(prev => !prev)
          break
        case 'f':
          if (!e.ctrlKey && !e.metaKey) {
            e.preventDefault()
            onClose()
          }
          break
        case 'c':
          e.preventDefault()
          setShowControls(prev => !prev)
          break
      }
    }

    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [isOpen, onClose])

  // Auto-scroll functionality
  useEffect(() => {
    if (!isPlaying || !iframeRef.current) return

    const scroll = () => {
      const container = iframeRef.current
      if (!container) return

      // Get current scroll position
      const currentScrollTop = container.scrollTop
      const scrollHeight = container.scrollHeight
      const clientHeight = container.clientHeight

      // Check if we've reached the bottom
      if (currentScrollTop + clientHeight >= scrollHeight - 10) {
        setIsPlaying(false)
        return
      }

      // Scroll the container div (which contains the iframe)
      container.scrollTop += scrollSpeed
    }

    scrollIntervalRef.current = setInterval(scroll, 100)
    
    return () => {
      if (scrollIntervalRef.current) {
        clearInterval(scrollIntervalRef.current)
      }
    }
  }, [isPlaying, scrollSpeed])

  // Initialize controls timer
  useEffect(() => {
    if (isOpen) {
      resetHideControlsTimer()
    }
    
    return () => {
      if (hideControlsTimeoutRef.current) {
        clearTimeout(hideControlsTimeoutRef.current)
      }
    }
  }, [isOpen, resetHideControlsTimer])

  const togglePlay = () => {
    setIsPlaying(prev => !prev)
  }

  const adjustSpeed = (delta: number) => {
    setScrollSpeed(prev => Math.max(0.5, Math.min(10, prev + delta)))
  }

  const resetToTop = () => {
    setIsPlaying(false)
    if (iframeRef.current) {
      iframeRef.current.scrollTo({
        top: 0,
        behavior: 'smooth'
      })
    }
  }

  const handleSpeedChange = (value: number[]) => {
    setScrollSpeed(value[0])
  }

  return (
    <Dialog open={isOpen} onOpenChange={onClose}>
      <DialogContent 
        ref={containerRef}
        className="bg-black text-white cursor-none"
        onMouseMove={handleMouseMove}
        style={{ cursor: showControls ? 'default' : 'none' }}
      >
        {/* Custom CSS for animations */}
        <style jsx>{`
          @keyframes fadeInOut {
            0% { opacity: 0; transform: translate(-50%, -50%) scale(0.9); }
            20% { opacity: 1; transform: translate(-50%, -50%) scale(1); }
            80% { opacity: 1; transform: translate(-50%, -50%) scale(1); }
            100% { opacity: 0; transform: translate(-50%, -50%) scale(0.9); }
          }
        `}</style>

        {/* PDF Container with scrollable wrapper */}
        <div 
          ref={iframeRef}
          className="w-full h-full overflow-auto scrollbar-thin scrollbar-thumb-white/20 scrollbar-track-transparent"
          style={{ scrollBehavior: isPlaying ? 'auto' : 'smooth' }}
        >
          <iframe
            src={`${pdfUrl}#toolbar=0&navpanes=0&scrollbar=0&view=FitH`}
            className="w-full border-none pointer-events-auto"
            title="Full Screen PDF Preview"
            style={{ 
              height: '500vh', 
              minHeight: '5000px',
              width: '100%'
            }}
          />
        </div>
        
        {/* Controls Overlay */}
        <div
          className={cn(
            "absolute inset-0 pointer-events-none transition-all duration-500 ease-in-out",
            showControls ? "opacity-100" : "opacity-0"
          )}
          onMouseEnter={() => setIsHoveringControls(true)}
          onMouseLeave={() => setIsHoveringControls(false)}
        >
          {/* Top Bar */}
          <div className="absolute top-0 left-0 right-0 bg-gradient-to-b from-black/80 to-transparent p-4 pointer-events-auto transform transition-transform duration-500 ease-in-out"
               style={{ transform: showControls ? 'translateY(0)' : 'translateY(-100%)' }}>
            <div className="flex items-center justify-between">
              <div className="flex-1">
                {title && (
                  <h2 className="text-lg font-semibold text-white truncate">
                    {title}
                  </h2>
                )}
                {subtitle && (
                  <p className="text-sm text-white/80 truncate">
                    {subtitle}
                  </p>
                )}
              </div>
              
              <div className="flex items-center gap-2 ml-4">
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={() => setIsSettingsOpen(!isSettingsOpen)}
                  className="text-white hover:bg-white/20"
                >
                  <Settings className="h-4 w-4" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={onClose}
                  className="text-white hover:bg-white/20"
                >
                  <X className="h-4 w-4" />
                </Button>
              </div>
            </div>
          </div>

          {/* Bottom Controls */}
          <div className="absolute bottom-0 left-0 right-0 bg-gradient-to-t from-black/80 to-transparent p-4 pointer-events-auto transform transition-transform duration-500 ease-in-out"
               style={{ transform: showControls ? 'translateY(0)' : 'translateY(100%)' }}>
            <div className="flex items-center justify-center gap-4">
              <Button
                variant="ghost"
                size="icon"
                onClick={resetToTop}
                className="text-white hover:bg-white/20"
                title="Reset to top (R)"
              >
                <RotateCcw className="h-4 w-4" />
              </Button>
              
              <Button
                variant="ghost"
                size="icon"
                onClick={() => adjustSpeed(0.5)}
                className="text-white hover:bg-white/20"
                title="Increase speed (↑)"
              >
                <ChevronUp className="h-4 w-4" />
              </Button>
              
              <Button
                variant="ghost"
                size="icon"
                onClick={togglePlay}
                className="text-white hover:bg-white/20 w-12 h-12"
                title={isPlaying ? "Pause (Space)" : "Play (Space)"}
              >
                {isPlaying ? (
                  <Pause className="h-6 w-6" />
                ) : (
                  <Play className="h-6 w-6" />
                )}
              </Button>
              
              <Button
                variant="ghost"
                size="icon"
                onClick={() => adjustSpeed(-0.5)}
                className="text-white hover:bg-white/20"
                title="Decrease speed (↓)"
              >
                <ChevronDown className="h-4 w-4" />
              </Button>
              
              <div className="flex items-center gap-2 text-white">
                <span className="text-sm">Speed: {scrollSpeed.toFixed(1)}px/s</span>
                {isPlaying && (
                  <div className="flex items-center gap-1">
                    <div className="w-2 h-2 bg-green-500 rounded-full animate-pulse"></div>
                    <span className="text-xs text-green-400">Scrolling</span>
                  </div>
                )}
              </div>
            </div>
          </div>

          {/* Controls Hidden Hint - Only show briefly */}
          {!showControls && !isSettingsOpen && (
            <div className="absolute top-1/2 left-1/2 transform -translate-x-1/2 -translate-y-1/2 pointer-events-none opacity-0 animate-pulse"
                 style={{ 
                   animation: 'fadeInOut 4s ease-in-out',
                   animationDelay: '1s'
                 }}>
              <div className="bg-black/60 backdrop-blur-sm rounded-lg px-4 py-2 text-white/70 text-sm">
                Move mouse to show controls • Press C to toggle
              </div>
            </div>
          )}

          {/* Subtle activity indicator when controls are hidden */}
          {!showControls && isPlaying && (
            <div className="absolute top-4 right-4 pointer-events-none">
              <div className="flex items-center gap-2 bg-black/40 backdrop-blur-sm rounded-full px-3 py-1">
                <div className="w-2 h-2 bg-green-500 rounded-full animate-pulse"></div>
                <span className="text-xs text-white/60">Auto-scrolling</span>
              </div>
            </div>
          )}

          {/* Settings Panel */}
          {isSettingsOpen && (
            <div className="absolute top-16 right-4 bg-black/90 backdrop-blur-sm rounded-lg p-4 min-w-[300px] pointer-events-auto transform transition-all duration-300 ease-in-out"
                 style={{ transform: showControls ? 'scale(1) opacity(1)' : 'scale(0.95) opacity(0.8)' }}>
              <h3 className="text-white font-medium mb-4">Autoscroll Settings</h3>
              
              <div className="space-y-4">
                <div>
                  <label className="block text-sm text-white/80 mb-2">
                    Scroll Speed: {scrollSpeed.toFixed(1)} px/s
                  </label>
                  <Slider
                    value={[scrollSpeed]}
                    onValueChange={handleSpeedChange}
                    min={0.5}
                    max={10}
                    step={0.5}
                    className="w-full"
                  />
                  <div className="flex justify-between text-xs text-white/60 mt-1">
                    <span>Slow (0.5)</span>
                    <span>Fast (10)</span>
                  </div>
                </div>
                
                <div className="pt-4 border-t border-white/20">
                  <h4 className="text-sm font-medium text-white mb-2">Keyboard Shortcuts</h4>
                  <div className="space-y-1 text-xs text-white/80">
                    <div className="flex justify-between">
                      <span>Play/Pause</span>
                      <span>Space or K</span>
                    </div>
                    <div className="flex justify-between">
                      <span>Speed Up/Down</span>
                      <span>↑/↓</span>
                    </div>
                    <div className="flex justify-between">
                      <span>Reset to Top</span>
                      <span>R</span>
                    </div>
                    <div className="flex justify-between">
                      <span>Settings</span>
                      <span>S</span>
                    </div>
                    <div className="flex justify-between">
                      <span>Toggle Controls</span>
                      <span>C</span>
                    </div>
                    <div className="flex justify-between">
                      <span>Exit Fullscreen</span>
                      <span>Esc or F</span>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}