import React, { useEffect, useRef, useState } from 'react';
import { motion } from 'motion/react';

interface ParticleBallProps {
  isListening: boolean;
  isSpeaking: boolean;
  isLoading: boolean;
  onClick: () => void;
  audioStream?: MediaStream | null;
  compact?: boolean;
}

interface Particle3D {
  baseX: number;
  baseY: number;
  baseZ: number;
  x: number;
  y: number;
  z: number;
  radius: number;
  color: string;
  theta: number;
  phi: number;
  speed: number;
  orbitRadius: number;
  waveOffset: number;
  layer: number; // 0 = inner core, 1 = surface, 2 = outer halo
}

export default function ParticleBall({
  isListening,
  isSpeaking,
  isLoading,
  onClick,
  audioStream,
  compact = false,
}: ParticleBallProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const animationFrameRef = useRef<number | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const dataArrayRef = useRef<Uint8Array | null>(null);

  // Setup Web Audio API Analyser for real microphone wave reaction
  useEffect(() => {
    if (audioStream && isListening) {
      try {
        const AudioCtx = window.AudioContext || (window as any).webkitAudioContext;
        const ctx = new AudioCtx();
        const analyser = ctx.createAnalyser();
        analyser.fftSize = 128;
        analyser.smoothingTimeConstant = 0.8;
        const source = ctx.createMediaStreamSource(audioStream);
        source.connect(analyser);

        const bufferLength = analyser.frequencyBinCount;
        const dataArray = new Uint8Array(bufferLength);

        audioContextRef.current = ctx;
        analyserRef.current = analyser;
        dataArrayRef.current = dataArray;
      } catch (err) {
        console.warn('Web Audio Analyser unavailable, using synthetic waves', err);
      }
    } else {
      if (audioContextRef.current && audioContextRef.current.state !== 'closed') {
        audioContextRef.current.close().catch(() => {});
        audioContextRef.current = null;
        analyserRef.current = null;
        dataArrayRef.current = null;
      }
    }

    return () => {
      if (audioContextRef.current && audioContextRef.current.state !== 'closed') {
        audioContextRef.current.close().catch(() => {});
      }
    };
  }, [audioStream, isListening]);

  // Main Canvas 3D Particle Sphere Simulation
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const handleResize = () => {
      if (!canvas) return;
      const rect = canvas.getBoundingClientRect();
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = (rect.width || 320) * dpr;
      canvas.height = (rect.height || 320) * dpr;
      ctx.scale(dpr, dpr);
    };

    handleResize();

    // Create 3D spherical particle system
    const numParticles = 220;
    const baseSphereRadius = 78;
    const particles: Particle3D[] = [];

    // Colors palette for high-fidelity glowing sphere
    const colors = [
      'rgba(99, 102, 241, ',  // Indigo
      'rgba(129, 140, 248, ', // Light Indigo
      'rgba(168, 85, 247, ',  // Purple
      'rgba(56, 189, 248, ',  // Sky Blue
      'rgba(236, 72, 153, ',  // Pink / Magenta
      'rgba(255, 255, 255, ', // White Core Specular
    ];

    // Fibonacci sphere distribution for uniform spherical dispersion
    const phi = Math.PI * (3 - Math.sqrt(5)); // Golden angle

    for (let i = 0; i < numParticles; i++) {
      const y = 1 - (i / (numParticles - 1)) * 2; // y goes from 1 to -1
      const radiusAtY = Math.sqrt(1 - y * y); // radius at y
      const theta = phi * i;

      const x = Math.cos(theta) * radiusAtY;
      const z = Math.sin(theta) * radiusAtY;

      // Multiple depth layers: dense core, main surface shell, outer ambient halo
      const layer = i % 5 === 0 ? 0 : i % 7 === 0 ? 2 : 1;
      let layerRadius = baseSphereRadius;
      if (layer === 0) layerRadius = baseSphereRadius * 0.55 + (Math.random() - 0.5) * 8;
      if (layer === 2) layerRadius = baseSphereRadius * 1.18 + (Math.random() - 0.5) * 10;
      if (layer === 1) layerRadius = baseSphereRadius + (Math.random() - 0.5) * 8;

      particles.push({
        baseX: x * layerRadius,
        baseY: y * layerRadius,
        baseZ: z * layerRadius,
        x: x * layerRadius,
        y: y * layerRadius,
        z: z * layerRadius,
        radius: layer === 0 ? 1.5 + Math.random() * 2 : layer === 2 ? 1.0 + Math.random() * 1.8 : 1.8 + Math.random() * 2.2,
        color: colors[i % colors.length],
        theta: Math.atan2(z, x),
        phi: Math.acos(y),
        speed: 0.006 + Math.random() * 0.008,
        orbitRadius: layerRadius,
        waveOffset: Math.random() * Math.PI * 2,
        layer,
      });
    }

    let rotX = 0;
    let rotY = 0;
    let time = 0;

    const render = () => {
      time += 0.025;
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const displayW = canvas.width / dpr;
      const displayH = canvas.height / dpr;
      const centerX = displayW / 2;
      const centerY = displayH / 2;

      ctx.clearRect(0, 0, displayW, displayH);

      // Determine sound energy level
      let voiceEnergy = 0;
      if (analyserRef.current && dataArrayRef.current && isListening) {
        analyserRef.current.getByteFrequencyData(dataArrayRef.current);
        let sum = 0;
        const count = Math.min(dataArrayRef.current.length, 32);
        for (let i = 0; i < count; i++) {
          sum += dataArrayRef.current[i];
        }
        voiceEnergy = (sum / (count * 255)) * 2.8;
      } else if (isListening) {
        voiceEnergy = 0.5 + Math.sin(time * 6) * 0.3;
      } else if (isSpeaking) {
        voiceEnergy = 0.75 + Math.sin(time * 7) * 0.35 + Math.cos(time * 11) * 0.2;
      } else if (isLoading) {
        voiceEnergy = 0.35 + Math.sin(time * 4) * 0.25;
      }

      // Rotation velocity: at rest when stopped/idle, spins fast when thinking (isLoading)
      let rotationSpeed = 0;
      if (isLoading) {
        rotationSpeed = 0.09; // Fast rotation while AI is thinking
        rotY += rotationSpeed;
        rotX = Math.sin(time * 1.5) * 0.3;
      } else if (isListening || isSpeaking) {
        rotationSpeed = 0.018 + voiceEnergy * 0.022;
        rotY += rotationSpeed;
        rotX = Math.sin(time * 0.8) * 0.22;
      }

      // Transform and project particles in 3D
      const projectedParticles: {
        x2d: number;
        y2d: number;
        z: number;
        radius: number;
        alpha: number;
        color: string;
      }[] = [];

      const isActive = isListening || isSpeaking || isLoading;

      for (let i = 0; i < particles.length; i++) {
        const p = particles[i];

        // Harmonic wave displacement equation - only active when listening/speaking/loading
        const waveFreq = isListening || isSpeaking ? 4.5 : 2.5;
        const waveSpeed = isListening || isSpeaking ? 4.2 : 1.6;
        const waveAmp = isActive ? (3 + voiceEnergy * 32) : 0;

        const wave = isActive 
          ? Math.sin(p.theta * waveFreq + time * waveSpeed + p.waveOffset) * Math.cos(p.phi * waveFreq - time * waveSpeed * 0.75)
          : 0;

        const currentRadius = p.orbitRadius + wave * waveAmp;

        // 3D coordinates on sphere
        const px = Math.cos(p.theta + rotY) * Math.sin(p.phi) * currentRadius;
        const py = Math.cos(p.phi) * currentRadius;
        const pz = Math.sin(p.theta + rotY) * Math.sin(p.phi) * currentRadius;

        // Apply pitch tilt (rotX)
        const cosX = Math.cos(rotX);
        const sinX = Math.sin(rotX);
        const y2 = py * cosX - pz * sinX;
        const z2 = py * sinX + pz * cosX;
        const x2 = px;

        // 3D Perspective Projection
        const fov = 270;
        const scale = fov / (fov + z2 + 35);
        const x2d = centerX + x2 * scale;
        const y2d = centerY + y2 * scale;

        // Depth-based opacity & size
        const depthAlpha = Math.max(0.2, Math.min(1, (z2 + baseSphereRadius + 45) / (baseSphereRadius * 2 + 45)));
        const finalAlpha = depthAlpha * (isActive ? (0.65 + voiceEnergy * 0.35) : 0.75);
        const finalSize = Math.max(1.1, p.radius * scale * (isActive ? (1 + voiceEnergy * 0.4) : 1));

        projectedParticles.push({
          x2d,
          y2d,
          z: z2,
          radius: finalSize,
          alpha: finalAlpha,
          color: p.color,
        });
      }

      // Sort by Z for realistic depth layering
      projectedParticles.sort((a, b) => a.z - b.z);

      // Draw subtle connecting energy wave lines between close neighbouring particles
      ctx.lineWidth = 0.75;
      const maxConnectDist = (isActive ? 32 * (1 + voiceEnergy * 0.4) : 26);
      for (let i = 0; i < projectedParticles.length; i += 2) {
        for (let j = i + 1; j < Math.min(i + 8, projectedParticles.length); j++) {
          const p1 = projectedParticles[i];
          const p2 = projectedParticles[j];
          const dx = p1.x2d - p2.x2d;
          const dy = p1.y2d - p2.y2d;
          const dist = Math.sqrt(dx * dx + dy * dy);

          if (dist < maxConnectDist) {
            const lineAlpha = (1 - dist / maxConnectDist) * 0.24 * Math.min(p1.alpha, p2.alpha);
            if (isSpeaking) {
              ctx.strokeStyle = `rgba(216, 180, 254, ${lineAlpha})`;
            } else {
              ctx.strokeStyle = `rgba(165, 180, 252, ${lineAlpha})`;
            }
            ctx.beginPath();
            ctx.moveTo(p1.x2d, p1.y2d);
            ctx.lineTo(p2.x2d, p2.y2d);
            ctx.stroke();
          }
        }
      }

      // Render individual 3D particles
      for (let i = 0; i < projectedParticles.length; i++) {
        const p = projectedParticles[i];
        ctx.fillStyle = `${p.color}${p.alpha})`;
        ctx.beginPath();
        ctx.arc(p.x2d, p.y2d, p.radius, 0, Math.PI * 2);
        ctx.fill();

        // Subtle specular highlight on frontal particles
        if (p.z > 15) {
          ctx.fillStyle = `rgba(255, 255, 255, ${p.alpha * 0.7})`;
          ctx.beginPath();
          ctx.arc(p.x2d - p.radius * 0.25, p.y2d - p.radius * 0.25, p.radius * 0.35, 0, Math.PI * 2);
          ctx.fill();
        }
      }

      animationFrameRef.current = requestAnimationFrame(render);
    };

    render();

    return () => {
      if (animationFrameRef.current) {
        cancelAnimationFrame(animationFrameRef.current);
      }
    };
  }, [isListening, isSpeaking, isLoading]);

  return (
    <motion.div
      onClick={onClick}
      whileHover={{ scale: 1.04 }}
      whileTap={{ scale: 0.96 }}
      className="relative flex items-center justify-center cursor-pointer select-none group"
      title={isListening ? 'Tap sphere to stop listening' : 'Tap sphere to talk'}
    >
      {/* Pure 3D Particle Canvas Sphere */}
      <canvas
        ref={canvasRef}
        className={`${
          compact 
            ? 'w-[64px] h-[64px] sm:w-[72px] sm:h-[72px]' 
            : 'w-[200px] h-[200px] sm:w-[240px] sm:h-[240px]'
        } transition-all duration-300 ease-out`}
        style={{ touchAction: 'none' }}
      />
    </motion.div>
  );
}
