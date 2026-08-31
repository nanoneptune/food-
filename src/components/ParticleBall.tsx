import React, { useEffect, useRef, useState } from 'react';
import { motion } from 'motion/react';

interface ParticleBallProps {
  isListening: boolean;
  isSpeaking: boolean;
  isLoading: boolean;
  onClick: () => void;
  audioStream?: MediaStream | null;
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

      // Determine sound energy level (from microphone analyser or synthetic speaking pulse)
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

      // Smooth rotation velocity
      const rotationSpeed = isListening || isSpeaking ? 0.02 + voiceEnergy * 0.018 : 0.009;
      rotY += rotationSpeed;
      rotX = Math.sin(time * 0.6) * 0.28;

      // Draw background ambient spherical glow
      const glowRadius = (baseSphereRadius + 24) * (1 + voiceEnergy * 0.4);
      const gradient = ctx.createRadialGradient(
        centerX,
        centerY,
        10,
        centerX,
        centerY,
        glowRadius + 45
      );

      if (isListening) {
        gradient.addColorStop(0, 'rgba(99, 102, 241, 0.45)');
        gradient.addColorStop(0.4, 'rgba(129, 140, 248, 0.25)');
        gradient.addColorStop(0.8, 'rgba(99, 102, 241, 0.08)');
        gradient.addColorStop(1, 'rgba(99, 102, 241, 0)');
      } else if (isSpeaking) {
        gradient.addColorStop(0, 'rgba(168, 85, 247, 0.5)');
        gradient.addColorStop(0.4, 'rgba(236, 72, 153, 0.25)');
        gradient.addColorStop(0.8, 'rgba(147, 51, 234, 0.08)');
        gradient.addColorStop(1, 'rgba(147, 51, 234, 0)');
      } else {
        gradient.addColorStop(0, 'rgba(99, 102, 241, 0.18)');
        gradient.addColorStop(0.5, 'rgba(129, 140, 248, 0.06)');
        gradient.addColorStop(1, 'rgba(255, 255, 255, 0)');
      }

      ctx.fillStyle = gradient;
      ctx.beginPath();
      ctx.arc(centerX, centerY, glowRadius + 45, 0, Math.PI * 2);
      ctx.fill();

      // Dense glowing core in the center of the sphere
      const corePulse = (baseSphereRadius * 0.35) * (1 + (isListening || isSpeaking ? voiceEnergy * 0.5 : Math.sin(time * 2) * 0.08));
      const coreGrad = ctx.createRadialGradient(centerX, centerY, 0, centerX, centerY, corePulse);
      if (isListening) {
        coreGrad.addColorStop(0, 'rgba(255, 255, 255, 0.95)');
        coreGrad.addColorStop(0.3, 'rgba(165, 180, 252, 0.7)');
        coreGrad.addColorStop(0.8, 'rgba(79, 70, 229, 0.2)');
        coreGrad.addColorStop(1, 'rgba(79, 70, 229, 0)');
      } else if (isSpeaking) {
        coreGrad.addColorStop(0, 'rgba(255, 255, 255, 0.95)');
        coreGrad.addColorStop(0.3, 'rgba(244, 114, 182, 0.7)');
        coreGrad.addColorStop(0.8, 'rgba(168, 85, 247, 0.2)');
        coreGrad.addColorStop(1, 'rgba(168, 85, 247, 0)');
      } else {
        coreGrad.addColorStop(0, 'rgba(199, 210, 254, 0.6)');
        coreGrad.addColorStop(0.5, 'rgba(99, 102, 241, 0.15)');
        coreGrad.addColorStop(1, 'rgba(99, 102, 241, 0)');
      }
      ctx.fillStyle = coreGrad;
      ctx.beginPath();
      ctx.arc(centerX, centerY, corePulse, 0, Math.PI * 2);
      ctx.fill();

      // Transform and project particles in 3D
      const projectedParticles: {
        x2d: number;
        y2d: number;
        z: number;
        radius: number;
        alpha: number;
        color: string;
      }[] = [];

      for (let i = 0; i < particles.length; i++) {
        const p = particles[i];

        // Harmonic wave displacement equation
        const waveFreq = isListening || isSpeaking ? 4.5 : 2.5;
        const waveSpeed = isListening || isSpeaking ? 4.2 : 1.6;
        const waveAmp = (5 + voiceEnergy * 36);

        const wave = Math.sin(p.theta * waveFreq + time * waveSpeed + p.waveOffset) *
                     Math.cos(p.phi * waveFreq - time * waveSpeed * 0.75);

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
        const depthAlpha = Math.max(0.18, Math.min(1, (z2 + baseSphereRadius + 45) / (baseSphereRadius * 2 + 45)));
        const finalAlpha = depthAlpha * (0.6 + voiceEnergy * 0.4);
        const finalSize = Math.max(1.1, p.radius * scale * (1 + voiceEnergy * 0.45));

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

      // Draw connecting energy wave lines between close neighbouring particles
      ctx.lineWidth = 0.8;
      const maxConnectDist = 34 * (1 + voiceEnergy * 0.45);
      for (let i = 0; i < projectedParticles.length; i += 2) {
        for (let j = i + 1; j < Math.min(i + 9, projectedParticles.length); j++) {
          const p1 = projectedParticles[i];
          const p2 = projectedParticles[j];
          const dx = p1.x2d - p2.x2d;
          const dy = p1.y2d - p2.y2d;
          const dist = Math.sqrt(dx * dx + dy * dy);

          if (dist < maxConnectDist) {
            const lineAlpha = (1 - dist / maxConnectDist) * 0.28 * Math.min(p1.alpha, p2.alpha);
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

      // Render individual 3D glowing particles
      for (let i = 0; i < projectedParticles.length; i++) {
        const p = projectedParticles[i];
        ctx.fillStyle = `${p.color}${p.alpha})`;
        ctx.beginPath();
        ctx.arc(p.x2d, p.y2d, p.radius, 0, Math.PI * 2);
        ctx.fill();

        // Specular glint on frontal active particles
        if (p.z > 15 && (isListening || isSpeaking || p.radius > 2.5)) {
          ctx.fillStyle = `rgba(255, 255, 255, ${p.alpha * 0.75})`;
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
      whileHover={{ scale: 1.05 }}
      whileTap={{ scale: 0.95 }}
      className="relative flex items-center justify-center cursor-pointer select-none group"
      title={isListening ? 'Tap sphere to stop listening' : 'Tap sphere to talk'}
    >
      {/* 3D Wave Particle Canvas Sphere */}
      <canvas
        ref={canvasRef}
        className="w-[300px] h-[300px] sm:w-[340px] sm:h-[340px] drop-shadow-2xl transition-transform duration-300"
        style={{ touchAction: 'none' }}
      />

      {/* Ripple halo ring when active */}
      {(isListening || isSpeaking) && (
        <motion.div
          initial={{ scale: 0.8, opacity: 0.7 }}
          animate={{ scale: 1.45, opacity: 0 }}
          transition={{ repeat: Infinity, duration: 1.8, ease: 'easeOut' }}
          className={`absolute inset-0 rounded-full border-2 pointer-events-none ${
            isSpeaking ? 'border-purple-400' : 'border-indigo-400'
          }`}
        />
      )}
    </motion.div>
  );
}
