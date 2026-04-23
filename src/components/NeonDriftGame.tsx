import React, { useEffect, useRef, useState } from 'react';

interface Point {
  x: number;
  y: number;
}

interface RoadSegment {
  p1: Point;
  p2: Point;
  width: number;
  hasBillboard?: boolean;
  billboardText?: string;
  billboardSide?: number; // 1 or -1
  hasSkyscraper?: boolean;
  skyscraperSize?: { w: number, h: number };
  skyscraperSide?: number;
  skyscraperDist?: number;
  skyscraperStyle?: number;
}

interface Player {
  x: number;
  y: number;
  angle: number;
  velocity: Point;
}

interface PoliceCar {
  x: number;
  y: number;
  angle: number;
  velocity: Point;
  active: boolean;
  spawnTime: number;
}

interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number; // 0 to 1
  size: number;
  color: string;
}

interface TrailPoint {
  x: number;
  y: number;
  life: number;
}

const SEGMENT_LENGTH = 180;
const MAX_SPEED = 9;
const ROTATION_SPEED = 0.07;
const ACCELERATION = 0.22;
const FRICTION = 0.985;
const LOOK_AHEAD = 15;

const DIFFICULTY_LEVELS = [
  { name: 'EASY', width: 220, twist: 0.1, threshold: 0 },
  { name: 'LEVEL 1', width: 220, twist: 0.8, threshold: 50 },
  { name: 'LEVEL 2', width: 140, twist: 0.1, threshold: 100 },
  { name: 'LEVEL 3', width: 140, twist: 1.0, threshold: 150 },
  { name: 'ELITE', width: 120, twist: 1.3, threshold: 200 },
];

export const NeonDriftGame: React.FC<{
  onGameOver: (score: number) => void;
  onStart: () => void;
}> = ({ onGameOver, onStart }) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  
  // UI State
  const [score, setScore] = useState(0);
  const [highScore, setHighScore] = useState(parseInt(localStorage.getItem('neon_drift_highscore') || '0'));
  const [isPlaying, setIsPlaying] = useState(false);
  const [isGameOver, setIsGameOver] = useState(false);
  const [showStory, setShowStory] = useState(false);
  const [currentLevelName, setCurrentLevelName] = useState('EASY');
  const [lives, setLives] = useState(3);

  // Mutable Game State (for 60fps)
  const gameRef = useRef({
    player: { x: 0, y: 0, angle: -Math.PI / 2, velocity: { x: 0, y: 0 } } as Player,
    road: [] as RoadSegment[],
    lastPoint: { x: 0, y: 0, angle: -Math.PI / 2 },
    score: 0,
    gameTime: 0,
    keys: {} as { [key: string]: boolean },
    particles: [] as Particle[],
    trail: [] as TrailPoint[],
    policeCars: [] as PoliceCar[],
    lastPoliceSpawnScore: 0,
    lives: 3,
    invincibility: 0,
    cameraShake: 0,
  });

  const lastTimeRef = useRef<number>(0);
  const requestRef = useRef<number>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const audioLoopRef = useRef<number | null>(null);
  const cleanupTimeoutRef = useRef<number | null>(null);

  // SFX Nodes
  const engineOscRef = useRef<OscillatorNode | null>(null);
  const engineGainRef = useRef<GainNode | null>(null);
  const driftNoiseRef = useRef<AudioBufferSourceNode | null>(null);
  const driftGainRef = useRef<GainNode | null>(null);
  const sirenOscRef = useRef<OscillatorNode | null>(null);
  const sirenGainRef = useRef<GainNode | null>(null);

  const createNoiseBuffer = (ctx: AudioContext) => {
    const bufferSize = ctx.sampleRate * 2;
    const buffer = ctx.createBuffer(1, bufferSize, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < bufferSize; i++) data[i] = Math.random() * 2 - 1;
    return buffer;
  };

  const startMusic = () => {
    if (!audioContextRef.current) {
      audioContextRef.current = new (window.AudioContext || (window as any).webkitAudioContext)();
    }
    
    const ctx = audioContextRef.current;
    if (ctx.state === 'suspended') {
      ctx.resume();
    }

    if (cleanupTimeoutRef.current) {
        clearTimeout(cleanupTimeoutRef.current);
        cleanupTimeoutRef.current = null;
    }

    // Stop existing loop if any
    if (audioLoopRef.current) {
      clearTimeout(audioLoopRef.current);
    }

    // Initialize/Re-initialize Engine Sound
    if (engineOscRef.current) {
        try { engineOscRef.current.stop(); } catch(e) {}
        engineOscRef.current.disconnect();
    }
    
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    const filter = ctx.createBiquadFilter();
    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(50, ctx.currentTime);
    filter.type = 'lowpass';
    filter.frequency.setValueAtTime(400, ctx.currentTime);
    gain.gain.setValueAtTime(0, ctx.currentTime);
    osc.connect(filter).connect(gain).connect(ctx.destination);
    osc.start();
    engineOscRef.current = osc;
    engineGainRef.current = gain;

    // Initialize/Re-initialize Drift Sound
    if (driftNoiseRef.current) {
        try { driftNoiseRef.current.stop(); } catch(e) {}
        driftNoiseRef.current.disconnect();
    }
    
    const source = ctx.createBufferSource();
    const dGain = ctx.createGain();
    const dFilter = ctx.createBiquadFilter();
    source.buffer = createNoiseBuffer(ctx);
    source.loop = true;
    dFilter.type = 'bandpass';
    dFilter.frequency.setValueAtTime(1000, ctx.currentTime);
    dFilter.Q.setValueAtTime(1, ctx.currentTime);
    dGain.gain.setValueAtTime(0, ctx.currentTime);
    source.connect(dFilter).connect(dGain).connect(ctx.destination);
    source.start();
    driftNoiseRef.current = source;
    driftGainRef.current = dGain;

    // Siren SFX
    const sirenOsc = ctx.createOscillator();
    const sirenGain = ctx.createGain();
    sirenOsc.type = 'square';
    sirenOsc.frequency.setValueAtTime(400, ctx.currentTime);
    sirenGain.gain.setValueAtTime(0, ctx.currentTime);
    sirenOsc.connect(sirenGain).connect(ctx.destination);
    sirenOsc.start();
    sirenOscRef.current = sirenOsc;
    sirenGainRef.current = sirenGain;

    const tempo = 155;
    const stepTime = 60 / tempo / 2; // 1/8 note

    const bassLine = [33, 33, 45, 33, 29, 29, 41, 29, 31, 31, 43, 31, 36, 36, 35, 35];
    const melody = [69, 0, 72, 74, 76, 0, 72, 69, 65, 0, 69, 71, 72, 0, 76, 79];
    const arpSequence = [
      [69, 72, 76, 81], [65, 69, 72, 77], [67, 71, 74, 79], [72, 76, 79, 84]
    ];

    let step = 0;
    const playStep = () => {
        if (!isPlayingRef.current) {
          audioLoopRef.current = null;
          return;
        }
        const time = ctx.currentTime;
        const beatInBar = step % 16;
        const arpChord = arpSequence[Math.floor(beatInBar / 4) % arpSequence.length];

        // NEON BASS
        const bassNote = bassLine[step % bassLine.length];
        if (bassNote > 0) {
            const osc = ctx.createOscillator();
            const gain = ctx.createGain();
            osc.type = 'triangle';
            osc.frequency.setValueAtTime(440 * Math.pow(2, (bassNote - 69) / 12), time);
            gain.gain.setValueAtTime(0.18, time);
            gain.gain.exponentialRampToValueAtTime(0.01, time + stepTime * 0.9);
            osc.connect(gain).connect(ctx.destination);
            osc.start(time);
            osc.stop(time + stepTime);
        }

        // SYNTH LEAD
        const melNote = melody[step % melody.length];
        if (melNote > 0) {
            const osc = ctx.createOscillator();
            const filter = ctx.createBiquadFilter();
            const gain = ctx.createGain();
            osc.type = 'square';
            osc.frequency.setValueAtTime(440 * Math.pow(2, (melNote - 69) / 12), time);
            filter.type = 'lowpass';
            filter.frequency.setValueAtTime(4000, time);
            filter.frequency.exponentialRampToValueAtTime(800, time + stepTime * 2);
            filter.Q.setValueAtTime(10, time);
            gain.gain.setValueAtTime(0.05, time);
            gain.gain.exponentialRampToValueAtTime(0.01, time + stepTime * 2.5);
            osc.connect(filter).connect(gain).connect(ctx.destination);
            osc.start(time);
            osc.stop(time + stepTime * 3);
        }

        // ARP
        const arpNote = arpChord[step % 4];
        const arpOsc = ctx.createOscillator();
        const arpGain = ctx.createGain();
        arpOsc.type = 'sawtooth';
        arpOsc.frequency.setValueAtTime(440 * Math.pow(2, (arpNote + 12 - 69) / 12), time);
        arpGain.gain.setValueAtTime(0.02, time);
        arpGain.gain.exponentialRampToValueAtTime(0.001, time + stepTime * 0.5);
        arpOsc.connect(arpGain).connect(ctx.destination);
        arpOsc.start(time);
        arpOsc.stop(time + stepTime * 0.5);

        // DRUMS
        if (step % 2 === 0) {
            const isKick = step % 4 === 0;
            const noise = ctx.createBufferSource();
            const buffer = ctx.createBuffer(1, ctx.sampleRate * 0.05, ctx.sampleRate);
            const data = buffer.getChannelData(0);
            for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
            noise.buffer = buffer;
            const noiseFilter = ctx.createBiquadFilter();
            noiseFilter.type = isKick ? 'lowpass' : 'highpass';
            noiseFilter.frequency.setValueAtTime(isKick ? 150 : 6000, time);
            const noiseGain = ctx.createGain();
            noiseGain.gain.setValueAtTime(isKick ? 0.2 : 0.08, time);
            noiseGain.gain.exponentialRampToValueAtTime(0.001, time + (isKick ? 0.1 : 0.05));
            noise.connect(noiseFilter).connect(noiseGain).connect(ctx.destination);
            noise.start(time);
        }

        step++;
        audioLoopRef.current = window.setTimeout(playStep, stepTime * 1000) as unknown as number;
    };

    playStep();
  };

  const stopMusic = () => {
    if (audioLoopRef.current) {
        clearTimeout(audioLoopRef.current);
        audioLoopRef.current = null;
    }
    // Shutdown sfx nodes properly
    const ctx = audioContextRef.current;
    if (ctx) {
        if (engineGainRef.current) engineGainRef.current.gain.setTargetAtTime(0, ctx.currentTime, 0.1);
        if (driftGainRef.current) driftGainRef.current.gain.setTargetAtTime(0, ctx.currentTime, 0.1);
        if (sirenGainRef.current) sirenGainRef.current.gain.setTargetAtTime(0, ctx.currentTime, 0.1);
        
        // Delay full stop slightly for ramp down
        cleanupTimeoutRef.current = window.setTimeout(() => {
          if (engineOscRef.current) {
            try { engineOscRef.current.stop(); } catch(e) {}
            engineOscRef.current.disconnect();
            engineOscRef.current = null;
          }
          if (driftNoiseRef.current) {
            try { driftNoiseRef.current.stop(); } catch(e) {}
            driftNoiseRef.current.disconnect();
            driftNoiseRef.current = null;
          }
          if (sirenOscRef.current) {
            try { sirenOscRef.current.stop(); } catch(e) {}
            sirenOscRef.current.disconnect();
            sirenOscRef.current = null;
          }
          cleanupTimeoutRef.current = null;
        }, 200);
    }
  };

  const playHoverSound = () => {
    if (!audioContextRef.current) return;
    const ctx = audioContextRef.current;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(800, ctx.currentTime);
    osc.frequency.exponentialRampToValueAtTime(1200, ctx.currentTime + 0.05);
    gain.gain.setValueAtTime(0.05, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.1);
    osc.connect(gain).connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.1);
  };

  const playCrashSound = () => {
    if (!audioContextRef.current) return;
    const ctx = audioContextRef.current;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    const noise = ctx.createBufferSource();
    const buffer = ctx.createBuffer(1, ctx.sampleRate * 0.3, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
    noise.buffer = buffer;

    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(100, ctx.currentTime);
    osc.frequency.exponentialRampToValueAtTime(40, ctx.currentTime + 0.3);
    
    const noiseFilter = ctx.createBiquadFilter();
    noiseFilter.type = 'lowpass';
    noiseFilter.frequency.setValueAtTime(500, ctx.currentTime);

    gain.gain.setValueAtTime(0.3, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.3);

    osc.connect(gain).connect(ctx.destination);
    noise.connect(noiseFilter).connect(gain).connect(ctx.destination);
    
    osc.start();
    noise.start();
    osc.stop(ctx.currentTime + 0.3);
    noise.stop(ctx.currentTime + 0.3);
  };

  // Add a ref to track isPlaying for the audio loop to avoid closures
  const isPlayingRef = useRef(false);
  useEffect(() => {
    isPlayingRef.current = isPlaying;
    if (isPlaying) {
      startMusic();
    } else {
      stopMusic();
    }
  }, [isPlaying]);

  const getDifficulty = (s: number) => {
    // After 200 points, can skip levels or be random
    if (s > 200) {
      const idx = Math.floor(Math.random() * (DIFFICULTY_LEVELS.length - 2)) + 2; // Random Level 2, 3 or Elite
      return DIFFICULTY_LEVELS[idx];
    }
    
    // Level buckets
    if (s < 50) return DIFFICULTY_LEVELS[0];
    if (s < 100) return DIFFICULTY_LEVELS[1];
    if (s < 150) return DIFFICULTY_LEVELS[2];
    return DIFFICULTY_LEVELS[3];
  };

  const initRoad = () => {
    const startRoad: RoadSegment[] = [];
    let currentX = 0;
    let currentY = 0;
    let currentAngle = -Math.PI / 2;

    const diff = DIFFICULTY_LEVELS[0]; // Start easy

    for (let i = 0; i < LOOK_AHEAD; i++) {
        const nextX = currentX + Math.cos(currentAngle) * SEGMENT_LENGTH;
        const nextY = currentY + Math.sin(currentAngle) * SEGMENT_LENGTH;
        startRoad.push({
            p1: { x: currentX, y: currentY },
            p2: { x: nextX, y: nextY },
            width: diff.width,
        });
        currentX = nextX;
        currentY = nextY;
    }
    gameRef.current.road = startRoad;
    gameRef.current.lastPoint = { x: currentX, y: currentY, angle: currentAngle };
    setCurrentLevelName(diff.name);
  };

  const extendRoad = () => {
    const { x, y, angle } = gameRef.current.lastPoint;
    const diff = getDifficulty(gameRef.current.score);
    
    // Procedural logic using level's twist factor
    const behavior = Math.random();
    let angleOffset = (Math.random() - 0.5) * diff.twist; 
    
    // Higher chance of circle segments if twisty
    if (diff.twist > 0.5 && behavior > 0.7) {
        angleOffset = (Math.random() > 0.5 ? 0.35 : -0.35) + (Math.random() - 0.5) * 0.1;
    }

    const nextAngle = angle + angleOffset;
    const nextX = x + Math.cos(nextAngle) * SEGMENT_LENGTH;
    const nextY = y + Math.sin(nextAngle) * SEGMENT_LENGTH;

    const billboardChance = Math.random();
    const hasBillboard = billboardChance > 0.85;
    const texts = ["DRIFT ODYSSEY", "LEVEL UP", "BOOST", "NEON CITY", "SHIFTWORKS"];
    
    const skyscraperChance = Math.random();
    const hasSkyscraper = skyscraperChance > 0.6; // More frequent skyscrapers
    
    const newSegment: RoadSegment = {
      p1: { x, y },
      p2: { x: nextX, y: nextY },
      width: diff.width,
      hasBillboard,
      billboardText: texts[Math.floor(Math.random() * texts.length)],
      billboardSide: Math.random() > 0.5 ? 1 : -1,
      hasSkyscraper,
      skyscraperSize: { w: 100 + Math.random() * 150, h: 100 + Math.random() * 150 },
      skyscraperSide: Math.random() > 0.5 ? 1 : -1,
      skyscraperDist: 150 + Math.random() * 200,
      skyscraperStyle: Math.floor(Math.random() * 3)
    };

    gameRef.current.road.push(newSegment);
    gameRef.current.lastPoint = { x: nextX, y: nextY, angle: nextAngle };
    
    if (gameRef.current.road.length > 60) {
      gameRef.current.road.shift();
    }

    if (currentLevelName !== diff.name) {
      setCurrentLevelName(diff.name);
    }
  };

  const startGame = () => {
    initRoad();
    gameRef.current.player = { x: 0, y: 0, angle: -Math.PI / 2, velocity: { x: 0, y: 0 } };
    gameRef.current.score = 0;
    gameRef.current.gameTime = 0;
    gameRef.current.particles = [];
    gameRef.current.trail = [];
    gameRef.current.policeCars = [];
    gameRef.current.lastPoliceSpawnScore = 0;
    gameRef.current.lives = 3;
    gameRef.current.invincibility = 0;
    gameRef.current.cameraShake = 0;
    
    setScore(0);
    setLives(3);
    setIsPlaying(true);
    setIsGameOver(false);
    setShowStory(false);
    onStart();
  };

  const handleEngageClick = () => {
    playHoverSound();
    setShowStory(true);
  };

  const returnToMenu = () => {
    setIsPlaying(false);
    setIsGameOver(false);
    setShowStory(false);
    stopMusic();
  };

  const distToSegment = (p: Point, v: Point, w: Point) => {
    const l2 = (v.x - w.x) ** 2 + (v.y - w.y) ** 2;
    if (l2 === 0) return Math.sqrt((p.x - v.x) ** 2 + (p.y - v.y) ** 2);
    let t = ((p.x - v.x) * (w.x - v.x) + (p.y - v.y) * (w.y - v.y)) / l2;
    t = Math.max(0, Math.min(1, t));
    return Math.sqrt((p.x - (v.x + t * (w.x - v.x)))**2 + (p.y - (v.y + t * (w.y - v.y)))**2);
  };

  const checkCollision = (p: Player, road: RoadSegment[]) => {
    // Check if player is NOT within any road segment bounds
    const isSafe = road.some(seg => {
      const d = distToSegment(p, seg.p1, seg.p2);
      return d <= seg.width / 2;
    });
    return !isSafe; 
  };

  const loop = (time: number) => {
    const deltaTime = time - (lastTimeRef.current || time);
    lastTimeRef.current = time;

    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');

    if (isPlaying && !isGameOver && canvas && ctx) {
      const g = gameRef.current;
      
      // Update Input
      if (g.keys['ArrowLeft'] || g.keys['KeyA']) g.player.angle -= ROTATION_SPEED;
      if (g.keys['ArrowRight'] || g.keys['KeyD']) g.player.angle += ROTATION_SPEED;

      // Physics
      const ax = Math.cos(g.player.angle) * ACCELERATION;
      const ay = Math.sin(g.player.angle) * ACCELERATION;

      g.player.velocity.x += ax;
      g.player.velocity.y += ay;
      g.player.velocity.x *= FRICTION;
      g.player.velocity.y *= FRICTION;

      const speed = Math.sqrt(g.player.velocity.x**2 + g.player.velocity.y**2);
      if (speed > MAX_SPEED) {
        g.player.velocity.x = (g.player.velocity.x / speed) * MAX_SPEED;
        g.player.velocity.y = (g.player.velocity.y / speed) * MAX_SPEED;
      }

      g.player.x += g.player.velocity.x;
      g.player.y += g.player.velocity.y;

      // Police Car Logic
      // Spawn police car every 40 points
      if (g.score - g.lastPoliceSpawnScore > 40 && g.policeCars.length < 3) {
        // Spawn behind player
        const spawnDist = 400;
        const spawnAngle = g.player.angle + Math.PI + (Math.random() - 0.5);
        g.policeCars.push({
          x: g.player.x + Math.cos(spawnAngle) * spawnDist,
          y: g.player.y + Math.sin(spawnAngle) * spawnDist,
          angle: g.player.angle,
          velocity: { x: 0, y: 0 },
          active: true,
          spawnTime: g.gameTime
        });
        g.lastPoliceSpawnScore = g.score;
      }

      // Update Police Cars AI
      g.policeCars.forEach(p => {
        if (!p.active) return;

        // Angle towards player
        const targetAngle = Math.atan2(g.player.y - p.y, g.player.x - p.x);
        
        // Interpolate angle
        let angleDiff = targetAngle - p.angle;
        while (angleDiff > Math.PI) angleDiff -= Math.PI * 2;
        while (angleDiff < -Math.PI) angleDiff += Math.PI * 2;
        p.angle += angleDiff * 0.04;

        // Acceleration
        const pAccel = 0.25;
        p.velocity.x += Math.cos(p.angle) * pAccel;
        p.velocity.y += Math.sin(p.angle) * pAccel;
        
        // Friction
        p.velocity.x *= 0.98;
        p.velocity.y *= 0.98;

        // Speed limit (police slightly faster if behind, or same)
        const pMaxSpeed = MAX_SPEED * 1.05;
        const pSpeed = Math.sqrt(p.velocity.x**2 + p.velocity.y**2);
        if (pSpeed > pMaxSpeed) {
          p.velocity.x = (p.velocity.x / pSpeed) * pMaxSpeed;
          p.velocity.y = (p.velocity.y / pSpeed) * pMaxSpeed;
        }

        p.x += p.velocity.x;
        p.y += p.velocity.y;

        // Police distance check (despawn if too far away)
        const distToPlayer = Math.sqrt((p.x - g.player.x)**2 + (p.y - g.player.y)**2);
        if (distToPlayer > 1500) {
          p.active = false;
        }

        // Collision with player
        if (g.invincibility <= 0 && distToPlayer < 35) {
          playCrashSound();
          g.lives -= 1;
          setLives(g.lives);
          g.invincibility = 2000;
          g.cameraShake = 20; // Trigger camera shake
          
          // Crash Particles (Fire/Explosion)
          for (let i = 0; i < 15; i++) {
            g.particles.push({
              x: (p.x + g.player.x) / 2,
              y: (p.y + g.player.y) / 2,
              vx: (Math.random() - 0.5) * 15,
              vy: (Math.random() - 0.5) * 15,
              life: 1.0,
              size: 10 + Math.random() * 10,
              color: Math.random() > 0.5 ? '#ff4d00' : '#ffae00', // Orange/Fire
            });
          }

          // Physics Bounce
          const bounceAngle = Math.atan2(g.player.y - p.y, g.player.x - p.x);
          const bounceForce = 12;
          g.player.velocity.x = Math.cos(bounceAngle) * bounceForce;
          g.player.velocity.y = Math.sin(bounceAngle) * bounceForce;

          p.active = false; // Despawn after hit
          
          if (g.lives <= 0) {
            setIsGameOver(true);
            setIsPlaying(false);
            const finalScore = Math.floor(g.score);
            if (finalScore > highScore) {
              localStorage.setItem('neon_drift_highscore', finalScore.toString());
              setHighScore(finalScore);
            }
            onGameOver(finalScore);
          }
        }
      });
      g.policeCars = g.policeCars.filter(p => p.active);

      // Trail Recording
      if (g.gameTime % 2 === 0) {
        g.trail.push({ x: g.player.x, y: g.player.y, life: 1.0 });
      }
      for (let i = g.trail.length - 1; i >= 0; i--) {
        g.trail[i].life -= 0.01;
        if (g.trail[i].life <= 0) g.trail.splice(i, 1);
      }
      
      if (g.invincibility > 0) g.invincibility -= deltaTime;
      if (g.cameraShake > 0) g.cameraShake *= 0.9;

      // Particle Emission (Drift Smoke)
      const velAngle = Math.atan2(g.player.velocity.y, g.player.velocity.x);
      const angleDiff = Math.abs(g.player.angle - velAngle);
      // Normalize angle diff to [0, PI]
      const normalizedDiff = Math.abs((Math.PI * 2 + angleDiff) % (Math.PI * 2) - Math.PI);
      const driftMagnitude = Math.sin(normalizedDiff) * speed;

      if (driftMagnitude > 3) {
        // Emit from rear left and right
        const rearX = g.player.x - Math.cos(g.player.angle) * 18;
        const rearY = g.player.y - Math.sin(g.player.angle) * 18;
        const perpX = -Math.sin(g.player.angle);
        const perpY = Math.cos(g.player.angle);

        const spawnParticle = (side: number) => {
          g.particles.push({
            x: rearX + perpX * 8 * side,
            y: rearY + perpY * 8 * side,
            vx: -g.player.velocity.x * 0.2 + (Math.random() - 0.5),
            vy: -g.player.velocity.y * 0.2 + (Math.random() - 0.5),
            life: 1.0,
            size: 5 + Math.random() * 8,
            color: Math.random() > 0.3 ? '#00f3ff' : '#db2777', // Cyan or Pink smoke
          });
        };

        spawnParticle(1);
        spawnParticle(-1);
      }

      // Update Particles
      for (let i = g.particles.length - 1; i >= 0; i--) {
        const p = g.particles[i];
        p.x += p.vx;
        p.y += p.vy;
        p.vx *= 0.95;
        p.vy *= 0.95;
        p.life -= 0.02;
        p.size += 0.5;
        if (p.life <= 0) {
          g.particles.splice(i, 1);
        }
      }

      // Procedural Road extension
      const distToLast = Math.sqrt((g.player.x - g.lastPoint.x)**2 + (g.player.y - g.lastPoint.y)**2);
      if (distToLast < 1200) {
        extendRoad();
      }

      // Score
      g.score += (speed / MAX_SPEED) * (deltaTime / 100);
      setScore(Math.floor(g.score));

      // Update SFX (Engine & Drift)
      const ctx_audio = audioContextRef.current;
      if (ctx_audio) {
          if (engineOscRef.current && engineGainRef.current) {
              const engineFreq = 50 + (speed / MAX_SPEED) * 150;
              const targetEngineVol = 0.3;
              engineOscRef.current.frequency.setTargetAtTime(engineFreq, ctx_audio.currentTime, 0.1);
              engineGainRef.current.gain.setTargetAtTime(targetEngineVol, ctx_audio.currentTime, 0.1);
          }
          if (driftGainRef.current) {
              const targetDriftVol = Math.min(0.5, Math.max(0, (driftMagnitude - 3) / 6));
              driftGainRef.current.gain.setTargetAtTime(targetDriftVol, ctx_audio.currentTime, 0.05);
          }
          if (sirenGainRef.current && sirenOscRef.current) {
              const hasActivePolice = g.policeCars.some(p => p.active);
              const targetSirenVol = hasActivePolice ? 0.1 : 0;
              sirenGainRef.current.gain.setTargetAtTime(targetSirenVol, ctx_audio.currentTime, 0.2);
              
              const sirenFreq = 400 + Math.sin(time / 150) * 200;
              sirenOscRef.current.frequency.setTargetAtTime(sirenFreq, ctx_audio.currentTime, 0.1);
          }
      }

      // Collision
      if (g.invincibility <= 0 && checkCollision(g.player, g.road)) {
        playCrashSound();
        g.lives -= 1;
        setLives(g.lives);
        
        if (g.lives <= 0) {
          setIsGameOver(true);
          setIsPlaying(false);
          const finalScore = Math.floor(g.score);
          if (finalScore > highScore) {
            localStorage.setItem('neon_drift_highscore', finalScore.toString());
            setHighScore(finalScore);
          }
          onGameOver(finalScore);
        } else {
          // Bounce back and invincibility
          g.invincibility = 1500;
          g.player.velocity.x *= -0.5;
          g.player.velocity.y *= -0.5;
        }
      }

      // RENDER
      ctx.fillStyle = '#05060f'; // Matches Frosted Glass bg
      ctx.fillRect(0, 0, canvas.width, canvas.height);

      ctx.save();
      // Apply Camera Shake
      if (g.cameraShake > 0.5) {
        ctx.translate((Math.random() - 0.5) * g.cameraShake, (Math.random() - 0.5) * g.cameraShake);
      }

      ctx.translate(canvas.width / 2, canvas.height / 2);
      ctx.translate(-g.player.x, -g.player.y);

      // Draw Trail
      if (g.trail.length > 1) {
        ctx.save();
        ctx.shadowBlur = 15;
        ctx.shadowColor = '#00f3ff';
        ctx.strokeStyle = '#00f3ff';
        ctx.lineWidth = 4;
        ctx.lineJoin = 'round';
        ctx.lineCap = 'round';
        ctx.beginPath();
        for (let i = 0; i < g.trail.length; i++) {
          const t = g.trail[i];
          ctx.globalAlpha = t.life * 0.5;
          if (i === 0) ctx.moveTo(t.x, t.y);
          else ctx.lineTo(t.x, t.y);
        }
        ctx.stroke();
        ctx.restore();
      }

      // Draw Particles (Smoke Trails)
      g.particles.forEach(p => {
        ctx.save();
        ctx.globalAlpha = p.life * 0.4;
        ctx.fillStyle = p.color;
        ctx.shadowBlur = p.size;
        ctx.shadowColor = p.color;
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
      });

      // Draw Grid (subtle)
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.02)';
      ctx.lineWidth = 1;
      const gridSize = 120;
      const startGridX = Math.floor((g.player.x - canvas.width) / gridSize) * gridSize;
      const startGridY = Math.floor((g.player.y - canvas.height) / gridSize) * gridSize;
      const endGridX = startGridX + canvas.width * 2;
      const endGridY = startGridY + canvas.height * 2;

      for (let x = startGridX; x <= endGridX; x += gridSize) {
        ctx.beginPath(); ctx.moveTo(x, startGridY); ctx.lineTo(x, endGridY); ctx.stroke();
      }
      for (let y = startGridY; y <= endGridY; y += gridSize) {
        ctx.beginPath(); ctx.moveTo(startGridX, y); ctx.lineTo(endGridX, y); ctx.stroke();
      }

      // Draw Road
      g.road.forEach((seg) => {
        // Asphalt Base
        ctx.fillStyle = '#0a0a14';
        ctx.lineWidth = seg.width;
        ctx.lineCap = 'round';
        ctx.beginPath();
        ctx.moveTo(seg.p1.x, seg.p1.y);
        ctx.lineTo(seg.p2.x, seg.p2.y);
        ctx.strokeStyle = '#0e0e1a';
        ctx.stroke();

        // Neon Strips & Checkered Curbs
        // Outer Cyan Strip
        ctx.shadowBlur = 10;
        ctx.shadowColor = '#00f3ff';
        ctx.strokeStyle = '#00f3ff';
        ctx.lineWidth = 4;
        
        // Calculate normals for edges
        const dx = seg.p2.x - seg.p1.x;
        const dy = seg.p2.y - seg.p1.y;
        const len = Math.sqrt(dx * dx + dy * dy);
        const nx = -dy / len;
        const ny = dx / len;

        const edgeDist = seg.width / 2;

        // Outer Neon Cyan
        ctx.beginPath();
        ctx.moveTo(seg.p1.x + nx * edgeDist, seg.p1.y + ny * edgeDist);
        ctx.lineTo(seg.p2.x + nx * edgeDist, seg.p2.y + ny * edgeDist);
        ctx.stroke();

        // Inner Neon Magenta
        ctx.shadowColor = '#db2777';
        ctx.strokeStyle = '#db2777';
        ctx.beginPath();
        ctx.moveTo(seg.p1.x - nx * edgeDist, seg.p1.y - ny * edgeDist);
        ctx.lineTo(seg.p2.x - nx * edgeDist, seg.p2.y - ny * edgeDist);
        ctx.stroke();

        ctx.shadowBlur = 0;

        // Checkered Curbs
        const curbWidth = 10;
        const patternScale = 40;
        ctx.lineWidth = curbWidth;
        
        for (let j = 0; j < len; j += patternScale) {
            const t1 = j / len;
            const t2 = Math.min(1, (j + patternScale / 2) / len);
            const t3 = Math.min(1, (j + patternScale) / len);

            const p1a = { x: seg.p1.x + dx * t1 + nx * (edgeDist + curbWidth / 2), y: seg.p1.y + dy * t1 + ny * (edgeDist + curbWidth / 2) };
            const p2a = { x: seg.p1.x + dx * t2 + nx * (edgeDist + curbWidth / 2), y: seg.p1.y + dy * t2 + ny * (edgeDist + curbWidth / 2) };
            
            ctx.strokeStyle = '#fff';
            ctx.beginPath(); ctx.moveTo(p1a.x, p1a.y); ctx.lineTo(p2a.x, p2a.y); ctx.stroke();
            
            ctx.strokeStyle = '#00f3ff';
            const p3a = { x: seg.p1.x + dx * t3 + nx * (edgeDist + curbWidth / 2), y: seg.p1.y + dy * t3 + ny * (edgeDist + curbWidth / 2) };
            ctx.beginPath(); ctx.moveTo(p2a.x, p2a.y); ctx.lineTo(p3a.x, p3a.y); ctx.stroke();

            // Symmetrical curb on other side
            const p1b = { x: seg.p1.x + dx * t1 - nx * (edgeDist + curbWidth / 2), y: seg.p1.y + dy * t1 - ny * (edgeDist + curbWidth / 2) };
            const p2b = { x: seg.p1.x + dx * t2 - nx * (edgeDist + curbWidth / 2), y: seg.p1.y + dy * t2 - ny * (edgeDist + curbWidth / 2) };
            ctx.strokeStyle = '#db2777';
            ctx.beginPath(); ctx.moveTo(p1b.x, p1b.y); ctx.lineTo(p2b.x, p2b.y); ctx.stroke();
            ctx.strokeStyle = '#fff';
            const p3b = { x: seg.p1.x + dx * t3 - nx * (edgeDist + curbWidth / 2), y: seg.p1.y + dy * t3 - ny * (edgeDist + curbWidth / 2) };
            ctx.beginPath(); ctx.moveTo(p2b.x, p2b.y); ctx.lineTo(p3b.x, p3b.y); ctx.stroke();
        }
      });

      // Sky Scrapers
      g.road.forEach(seg => {
        if (seg.hasSkyscraper && seg.skyscraperSize) {
          const dx = seg.p2.x - seg.p1.x;
          const dy = seg.p2.y - seg.p1.y;
          const len = Math.sqrt(dx * dx + dy * dy);
          const nx = -dy / len;
          const ny = dx / len;
          const side = seg.skyscraperSide || 1;
          const dist = seg.width / 2 + (seg.skyscraperDist || 150);

          const sx = seg.p1.x + dx * 0.5 + nx * dist * side;
          const sy = seg.p1.y + dy * 0.5 + ny * dist * side;
          const angle = Math.atan2(dy, dx);

          ctx.save();
          ctx.translate(sx, sy);
          ctx.rotate(angle);
          
          const sw = seg.skyscraperSize.w;
          const sh = seg.skyscraperSize.h;

          // Building Body
          ctx.fillStyle = '#0a0a14';
          ctx.strokeStyle = side > 0 ? 'rgba(0, 243, 255, 0.2)' : 'rgba(219, 39, 119, 0.2)';
          ctx.lineWidth = 2;
          ctx.beginPath();
          ctx.roundRect(-sw/2, -sh/2, sw, sh, 4);
          ctx.fill();
          ctx.stroke();

          // Windows (Grid)
          ctx.fillStyle = side > 0 ? 'rgba(0, 243, 255, 0.1)' : 'rgba(219, 39, 119, 0.1)';
          const winSize = 10;
          const winGap = 15;
          for (let wx = -sw/2 + 10; wx < sw/2 - 10; wx += winGap) {
            for (let wy = -sh/2 + 10; wy < sh/2 - 10; wy += winGap) {
              if (Math.random() > 0.3) {
                ctx.fillRect(wx, wy, winSize, winSize);
              }
            }
          }

          // Top Neon Rim
          ctx.shadowBlur = 15;
          ctx.shadowColor = side > 0 ? '#00f3ff' : '#db2777';
          ctx.strokeStyle = ctx.shadowColor;
          ctx.lineWidth = 2;
          ctx.strokeRect(-sw/2, -sh/2, sw, sh);
          
          ctx.restore();
        }
      });

      // Billboards
      g.road.forEach(seg => {
        if (seg.hasBillboard && seg.billboardText) {
          const dx = seg.p2.x - seg.p1.x;
          const dy = seg.p2.y - seg.p1.y;
          const len = Math.sqrt(dx * dx + dy * dy);
          const nx = -dy / len;
          const ny = dx / len;
          const side = seg.billboardSide || 1;
          const dist = seg.width / 2 + 50;

          const bx = seg.p1.x + dx * 0.5 + nx * dist * side;
          const by = seg.p1.y + dy * 0.5 + ny * dist * side;
          const angle = Math.atan2(dy, dx);

          ctx.save();
          ctx.translate(bx, by);
          ctx.rotate(angle);
          
          // Board
          ctx.fillStyle = 'rgba(0, 0, 0, 0.8)';
          ctx.strokeStyle = side > 0 ? '#00f3ff' : '#db2777';
          ctx.lineWidth = 2;
          ctx.shadowBlur = 10;
          ctx.shadowColor = ctx.strokeStyle;
          ctx.beginPath();
          ctx.roundRect(-40, -15, 80, 30, 4);
          ctx.fill();
          ctx.stroke();

          // Text
          ctx.fillStyle = '#fff';
          ctx.font = 'bold 8px Inter';
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillText(seg.billboardText, 0, 0);

          // Support poles
          ctx.shadowBlur = 0;
          ctx.strokeStyle = '#444';
          ctx.beginPath();
          ctx.moveTo(-30, 15); ctx.lineTo(-30, 40);
          ctx.moveTo(30, 15); ctx.lineTo(30, 40);
          ctx.stroke();

          ctx.restore();
        }
      });

      // Draw Police Cars
      g.policeCars.forEach(p => {
        if (!p.active) return;
        ctx.save();
        ctx.translate(p.x, p.y);
        ctx.rotate(p.angle);

        // Flashing Lights
        const flash = Math.floor(time / 100) % 2 === 0;
        
        // Light Glows
        const drawLight = (lx: number, ly: number, color: string, isActive: boolean) => {
          if (!isActive) return;
          ctx.save();
          ctx.shadowBlur = 20;
          ctx.shadowColor = color;
          ctx.fillStyle = color;
          ctx.globalAlpha = 0.6;
          ctx.beginPath();
          ctx.arc(lx, ly, 15, 0, Math.PI * 2);
          ctx.fill();
          ctx.restore();
        };

        drawLight(10, -8, '#ff0000', flash);
        drawLight(10, 8, '#0000ff', !flash);

        // Car Body (Black/White)
        ctx.shadowBlur = 10;
        ctx.shadowColor = 'rgba(0,0,0,0.5)';
        ctx.fillStyle = '#111';
        ctx.beginPath();
        ctx.roundRect(-22, -14, 44, 28, 4);
        ctx.fill();

        // White Doors
        ctx.fillStyle = '#eee';
        ctx.fillRect(-8, -14, 16, 3);
        ctx.fillRect(-8, 11, 16, 3);

        // Police Text
        ctx.fillStyle = '#fff';
        ctx.font = 'bold 6px sans-serif';
        ctx.save();
        ctx.rotate(Math.PI / 2);
        ctx.textAlign = 'center';
        ctx.fillText("POLICE", 0, 18);
        ctx.restore();

        // Roof Light Bar
        ctx.fillStyle = flash ? '#ff0000' : '#0000ff';
        ctx.fillRect(-2, -10, 4, 20);

        ctx.restore();
      });

      // Center Line
      ctx.setLineDash([20, 40]);
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.3)';
      ctx.lineWidth = 2;
      ctx.beginPath();
      g.road.forEach((seg, i) => {
        if (i === 0) ctx.moveTo(seg.p1.x, seg.p1.y);
        ctx.lineTo(seg.p2.x, seg.p2.y);
      });
      ctx.stroke();
      ctx.setLineDash([]);

      // Player / Car
      ctx.save();
      ctx.translate(g.player.x, g.player.y);
      ctx.rotate(g.player.angle);

      const isSteeringLeft = g.keys['ArrowLeft'] || g.keys['KeyA'];
      const isSteeringRight = g.keys['ArrowRight'] || g.keys['KeyD'];
      const wheelAngle = isSteeringLeft ? -0.4 : (isSteeringRight ? 0.4 : 0);

      // Headlight Glow
      const grad = ctx.createRadialGradient(25, 0, 5, 60, 0, 50);
      grad.addColorStop(0, 'rgba(0, 243, 255, 0.4)');
      grad.addColorStop(1, 'rgba(0, 243, 255, 0)');
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.moveTo(15, -10);
      ctx.lineTo(80, -40);
      ctx.lineTo(80, 40);
      ctx.lineTo(15, 10);
      ctx.fill();

      // WHEELS (Visible)
      const drawWheel = (wx: number, wy: number, angle: number) => {
        ctx.save();
        ctx.translate(wx, wy);
        ctx.rotate(angle);
        ctx.fillStyle = '#111';
        ctx.beginPath();
        ctx.roundRect(-6, -3, 12, 6, 2);
        ctx.fill();
        // Wheel highlight
        ctx.strokeStyle = '#333';
        ctx.lineWidth = 1;
        ctx.stroke();
        ctx.restore();
      };

      // Rear Wheels (Static)
      drawWheel(-14, -13, 0);
      drawWheel(-14, 13, 0);
      
      // Front Wheels (Steering)
      drawWheel(14, -13, wheelAngle);
      drawWheel(14, 13, wheelAngle);

      // Detailed Car Body
      ctx.shadowBlur = 15;
      ctx.shadowColor = 'rgba(189, 39, 119, 0.5)'; // Pink glow base
      
      // Car Shadow/Outline
      ctx.fillStyle = 'rgba(0, 0, 0, 0.5)';
      ctx.beginPath();
      ctx.roundRect(-24, -15, 48, 30, 8);
      ctx.fill();

      // Main Body (Dark Blue/Purple Gradient)
      const bodyGrad = ctx.createLinearGradient(-20, 0, 20, 0);
      bodyGrad.addColorStop(0, '#4f46e5');
      bodyGrad.addColorStop(1, '#0066cc');
      ctx.fillStyle = bodyGrad;
      ctx.beginPath();
      ctx.roundRect(-22, -14, 44, 28, 6);
      ctx.fill();

      // Top Highlight (Cyan Plate)
      ctx.fillStyle = '#00f3ff';
      ctx.beginPath();
      ctx.roundRect(-20, -12, 40, 24, 4);
      ctx.fill();

      // Roof & Glass (Darker)
      ctx.fillStyle = '#05060f';
      ctx.beginPath();
      ctx.roundRect(-5, -10, 18, 20, 3);
      ctx.fill();

      // Side Windows
      ctx.fillStyle = '#1a1a1a';
      ctx.beginPath();
      ctx.roundRect(-8, -9, 12, 3, 1);
      ctx.roundRect(-8, 6, 12, 3, 1);
      ctx.fill();

      // Neon Patterns (Magenta Lines)
      ctx.shadowColor = '#db2777';
      ctx.shadowBlur = 8;
      ctx.strokeStyle = '#db2777';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      // Hood lines
      ctx.moveTo(5, -8); ctx.lineTo(18, -11);
      ctx.moveTo(5, 8); ctx.lineTo(18, 11);
      // Roof trim
      ctx.moveTo(-5, -10); ctx.lineTo(13, -10);
      ctx.moveTo(-5, 10); ctx.lineTo(13, 10);
      ctx.stroke();

      // Text Details
      ctx.shadowBlur = 0;
      ctx.fillStyle = 'rgba(255, 255, 255, 0.7)';
      ctx.font = 'bold 4px sans-serif';
      ctx.save();
      ctx.translate(5, 0);
      ctx.rotate(Math.PI / 2);
      ctx.textAlign = 'center';
      ctx.fillText("DRIFT", 0, -12);
      ctx.restore();

      ctx.save();
      ctx.translate(-15, 0);
      ctx.rotate(Math.PI / 2);
      ctx.textAlign = 'center';
      ctx.fillText("KING", 0, 0);
      ctx.restore();

      // Spoiler (Rear Wing)
      ctx.fillStyle = '#00f3ff';
      ctx.shadowColor = '#00f3ff';
      ctx.shadowBlur = 5;
      ctx.beginPath();
      ctx.roundRect(-25, -12, 4, 24, 1);
      ctx.fill();

      // Taillights (Glow)
      ctx.fillStyle = '#ff0055';
      ctx.shadowColor = '#ff0055';
      ctx.shadowBlur = 10;
      ctx.fillRect(-22, -10, 2, 4);
      ctx.fillRect(-22, 6, 2, 4);

      ctx.restore();
      ctx.restore();
    }

    requestRef.current = requestAnimationFrame(loop);
  };

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => { gameRef.current.keys[e.code] = true; };
    const handleKeyUp = (e: KeyboardEvent) => { gameRef.current.keys[e.code] = false; };
    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('keyup', handleKeyUp);

    const canvas = canvasRef.current;
    const resize = () => {
      if (canvas) {
        canvas.width = window.innerWidth;
        canvas.height = window.innerHeight;
      }
    };
    window.addEventListener('resize', resize);
    resize();

    requestRef.current = requestAnimationFrame(loop);

    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('keyup', handleKeyUp);
      window.removeEventListener('resize', resize);
      if (requestRef.current) cancelAnimationFrame(requestRef.current);
      if (audioLoopRef.current) clearTimeout(audioLoopRef.current);
      
      // Cleanup SFX nodes
      if (engineOscRef.current) {
          try { engineOscRef.current.stop(); } catch(e) {}
          engineOscRef.current.disconnect();
          engineOscRef.current = null;
      }
      if (driftNoiseRef.current) {
          try { driftNoiseRef.current.stop(); } catch(e) {}
          driftNoiseRef.current.disconnect();
          driftNoiseRef.current = null;
      }
      if (audioContextRef.current) {
          audioContextRef.current.close();
      }
    };
  }, [isPlaying, isGameOver]);

  return (
    <div id="game-container" className="relative w-full h-full overflow-hidden bg-[#05060f] select-none font-sans text-white">
      {/* Background Decor */}
      <div className="mesh-glow-1" />
      <div className="mesh-glow-2" />
      <div className="crt-scanlines" />
      <div className="absolute top-0 left-0 w-full h-1 bg-gradient-to-r from-transparent via-cyan-500 to-transparent opacity-50 z-40" />
      <div className="absolute bottom-0 left-0 w-full h-1 bg-gradient-to-r from-transparent via-pink-500 to-transparent opacity-50 z-40" />

      <canvas id="game-canvas" ref={canvasRef} className="block cursor-crosshair" />
      
      {/* TOP HUD */}
      <div id="top-hud" className="absolute top-8 left-8 right-8 flex justify-between items-start z-40 pointer-events-none">
        <div className="flex flex-col gap-4">
          <div id="hud-score-container" className="bg-white/5 backdrop-blur-xl border border-white/10 p-6 rounded-2xl min-w-[220px]">
            <div className="text-[10px] uppercase tracking-[0.2em] text-cyan-400 font-bold mb-1">Current Score</div>
            <div id="current-score" className="text-4xl font-black tabular-nums tracking-tighter">
              {score.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",")}
            </div>
          </div>

          {/* FUEL / LIVES */}
          <div id="fuel-gauge" className="bg-white/5 backdrop-blur-xl border border-white/10 p-4 rounded-2xl flex flex-col gap-2 min-w-[220px] pointer-events-auto">
            <div className="flex justify-between items-center pr-2">
              <span className="text-[10px] uppercase tracking-[0.2em] text-pink-500 font-bold">Fuel Cells</span>
              <span className="text-[10px] font-bold text-white">{lives}/3</span>
            </div>
            <div className="flex gap-2 h-3">
              {[...Array(3)].map((_, i) => (
                <div 
                  key={i}
                  className={`flex-1 rounded-sm transition-all duration-300 ${i < lives ? 'bg-pink-500 shadow-[0_0_10px_rgba(219,39,119,0.5)]' : 'bg-white/10'}`}
                />
              ))}
            </div>
          </div>
        </div>

        <div className="flex flex-col gap-4 items-end">
          <div className="flex gap-4">
            <div className="bg-white/5 backdrop-blur-xl border border-white/10 p-4 rounded-2xl text-right min-w-[140px]">
              <div className="text-[10px] uppercase tracking-[0.2em] text-gray-400 font-bold mb-1">Best Run</div>
              <div id="record-score" className="text-xl font-bold tabular-nums">
                {highScore.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",")}
              </div>
            </div>
            <div className="bg-white/5 backdrop-blur-xl border border-white/10 p-4 rounded-2xl text-right min-w-[120px]">
              <div className="text-[10px] uppercase tracking-[0.2em] text-pink-500 font-bold mb-1">System</div>
              <div className="text-xl font-bold tabular-nums">ACTIVE</div>
            </div>
          </div>

          {isPlaying && (
            <div className="flex gap-2">
              <button 
                onClick={() => { playHoverSound(); startGame(); }}
                onMouseEnter={playHoverSound}
                className="bg-white/5 hover:bg-white/10 backdrop-blur-xl border border-white/10 px-6 py-3 rounded-xl pointer-events-auto transition-all text-[10px] font-bold tracking-[0.3em] text-cyan-400"
              >
                RESET RUN
              </button>
              <button 
                onClick={() => { playHoverSound(); returnToMenu(); }}
                onMouseEnter={playHoverSound}
                className="bg-white/5 hover:bg-white/10 backdrop-blur-xl border border-white/10 px-6 py-3 rounded-xl pointer-events-auto transition-all text-[10px] font-bold tracking-[0.3em] text-pink-500"
              >
                MAIN MENU
              </button>
            </div>
          )}
        </div>
      </div>

      {/* CENTER STATUS - Removed as requested */}

      {/* BOTTOM HUD */}
      <div id="bottom-hud" className="absolute bottom-8 left-8 right-8 flex justify-between items-end z-40 pointer-events-none">
        {/* Controls */}
        <div id="controls-hint" className="flex gap-3">
          <div className="flex flex-col items-center gap-2">
            <div className="w-12 h-12 bg-white/10 backdrop-blur-md border border-white/20 rounded-lg flex items-center justify-center font-bold text-xl">A</div>
            <span className="text-[9px] uppercase tracking-widest text-gray-400">LEFT</span>
          </div>
          <div className="flex flex-col items-center gap-2">
            <div className="w-12 h-12 bg-white/10 backdrop-blur-md border border-white/20 rounded-lg flex items-center justify-center font-bold text-xl">D</div>
            <span className="text-[9px] uppercase tracking-widest text-gray-400">RIGHT</span>
          </div>
        </div>

        {/* Speedometer */}
        <div id="speedometer" className="bg-white/5 backdrop-blur-2xl border border-white/10 rounded-full w-44 h-44 flex flex-col items-center justify-center relative shadow-[0_0_50px_rgba(0,243,255,0.05)] overflow-hidden">
          <svg className="absolute inset-0 -rotate-90" width="176" height="176">
            <circle cx="88" cy="88" r="74" stroke="rgba(255,255,255,0.05)" strokeWidth="10" fill="none" />
            <circle 
              cx="88" cy="88" r="74" 
              stroke="#00f3ff" strokeWidth="10" fill="none" 
              strokeDasharray={`${(Math.sqrt(gameRef.current.player.velocity.x**2 + gameRef.current.player.velocity.y**2) / MAX_SPEED) * 465} 465`} 
              strokeLinecap="round" 
              className="transition-all duration-150"
            />
          </svg>
          <div className="text-4xl font-black tracking-tighter tabular-nums">
            {Math.floor((Math.sqrt(gameRef.current.player.velocity.x**2 + gameRef.current.player.velocity.y**2) / MAX_SPEED) * 240)}
          </div>
          <div className="text-[10px] uppercase tracking-widest text-cyan-400 font-bold">KM/H</div>
        </div>

        {/* Env Stats */}
        <div id="env-stats" className="bg-white/5 backdrop-blur-xl border border-white/10 p-6 rounded-2xl min-w-[200px]">
          <div className="flex justify-between items-center mb-3">
            <span className="text-[10px] uppercase tracking-widest text-gray-400">Traction</span>
            <span className={`text-[10px] font-bold ${isGameOver ? 'text-red-500' : 'text-yellow-400'}`}>
              {Math.sqrt(gameRef.current.player.velocity.x**2 + gameRef.current.player.velocity.y**2) > MAX_SPEED * 0.7 ? 'SLIPPING' : 'STABLE'}
            </span>
          </div>
          <div className="w-full h-1 bg-white/10 rounded-full overflow-hidden">
            <div 
              className="h-full bg-yellow-400 transition-all duration-300" 
              style={{ width: `${Math.max(10, 100 - (Math.sqrt(gameRef.current.player.velocity.x**2 + gameRef.current.player.velocity.y**2) / MAX_SPEED) * 80)}%` }}
            />
          </div>
          <div className="mt-4 flex justify-between items-center">
            <span className="text-[10px] uppercase tracking-widest text-gray-400">Road Complexity</span>
            <span id="level-display" className="text-xs font-bold uppercase tracking-tight text-white">{currentLevelName}</span>
          </div>
        </div>
      </div>

      {/* MAIN MENU */}
      {!isPlaying && !isGameOver && !showStory && (
        <div id="main-menu" className="absolute inset-0 flex flex-col items-center justify-center z-50 bg-[#05060f]/60 backdrop-blur-sm">
          <div className="relative group">
            <h1 
              id="game-title" 
              data-text="SYNDICATE DRIFT"
              className="glitch-effect text-9xl font-black text-white tracking-tighter mb-0 italic transform -skew-x-12 select-none leading-none"
            >
              SYNDICATE<br/>DRIFT
            </h1>
            <div className="absolute -top-6 -left-6 w-16 h-16 border-t-2 border-l-2 border-cyan-400 opacity-50" />
            <div className="absolute -bottom-6 -right-6 w-16 h-16 border-b-2 border-r-2 border-pink-500 opacity-50" />
          </div>
          
          <p id="game-subtitle" className="mt-12 text-white/40 tracking-[1em] text-[10px] uppercase font-light">Simulation Active</p>
          
          <button 
            id="start-button"
            onClick={handleEngageClick}
            onMouseEnter={playHoverSound}
            className="mt-16 group relative px-20 py-5 overflow-hidden pointer-events-auto"
          >
            <div className="absolute inset-0 border border-white/20 group-hover:border-cyan-400 group-hover:scale-105 transition-all duration-300 rounded-xl" />
            <div className="absolute inset-0 bg-white opacity-0 group-hover:opacity-5 transition-opacity" />
            <span className="relative text-white group-hover:text-cyan-400 font-bold tracking-[0.6em] text-sm transition-colors uppercase">Engage</span>
          </button>
        </div>
      )}

      {/* STORY SCREEN */}
      {showStory && (
        <div id="story-screen" className="absolute inset-0 flex flex-col items-center justify-center z-50 bg-black overflow-hidden p-8 px-4 sm:px-8">
          {/* Halftone / Comic Background Texture */}
          <div className="absolute inset-0 opacity-10 pointer-events-none bg-[radial-gradient(#ffffff_1px,transparent_1px)] [background-size:20px_20px]" />
          
          <div className="relative max-w-4xl w-full flex flex-col gap-6 transform skew-y-1">
            {/* Header Panel */}
            <div className="bg-yellow-400 p-4 border-4 border-black shadow-[8px_8px_0_0_rgba(0,0,0,1)] relative z-10 w-fit -rotate-2">
              <h3 className="text-black font-black text-2xl sm:text-4xl italic uppercase tracking-tighter">MISSION LOG: NEON HEIST</h3>
            </div>

            {/* Main Comic Panel */}
            <div className="flex flex-col sm:flex-row gap-6">
              <div className="flex-1 bg-[#1a1a1a] border-4 border-white p-6 shadow-[12px_12px_0_0_rgba(219,39,119,0.5)] flex flex-col justify-center gap-4 relative overflow-hidden rotate-1 mt-4 sm:mt-0">
                 {/* Action Line Decorations */}
                <div className="absolute top-0 right-0 w-32 h-1 bg-white rotate-45 translate-x-10 translate-y-10" />
                <div className="absolute bottom-0 left-0 w-48 h-1 bg-cyan-400 -rotate-12 -translate-x-10 -translate-y-10" />
                
                <p className="text-white text-lg sm:text-2xl font-bold leading-tight italic uppercase tracking-tight">
                  <span className="text-cyan-400">STATUS:</span> HEIST COMPLETE. <br/>
                  <span className="text-pink-500">ASSET:</span> NEURAL CORE PROTOCOL-X. <br/>
                </p>
                <div className="h-0.5 w-full bg-white/20" />
                <p className="text-white/80 text-sm sm:text-base font-medium leading-relaxed uppercase tracking-widest">
                  YOU BURST THROUGH THE SYNDICATE'S SECURE FACILITY. THE CORE IS SECURED, BUT THE ALARM IS TRIPPED. THE ENTIRE NEO-CITY POLICE FORCE IS DEPLOYING.
                </p>
                
                {/* Speech Bubble Style Callout */}
                <div className="absolute -top-4 -right-2 bg-pink-500 text-white font-black p-2 px-4 text-sm rotate-12 border-2 border-black animate-pulse">
                  ALARM: CODE RED!
                </div>
              </div>

              {/* Character/Target Panel */}
              <div className="w-full sm:w-64 bg-cyan-400 border-4 border-black p-4 flex flex-col items-center justify-center shadow-[8px_8px_0_0_rgba(219,39,119,1)] -rotate-3 mt-4 sm:mt-0">
                <div className="w-24 h-24 sm:w-32 sm:h-32 bg-black rounded-lg border-2 border-white mb-4 flex items-center justify-center overflow-hidden">
                   <div className="w-full h-full bg-gradient-to-tr from-pink-500 via-transparent to-cyan-400 animate-pulse opacity-50" />
                   <p className="absolute text-white font-black text-3xl">!!!</p>
                </div>
                <p className="text-black font-black text-center text-xs uppercase tracking-tighter leading-none">OBJECTIVE: <br/>SURVIVE THE DRIFT</p>
              </div>
            </div>

            {/* Bottom Caption */}
            <div className="self-end bg-white p-4 border-4 border-black shadow-[-8px_8px_0_0_rgba(0,243,255,1)] rotate-1 w-full sm:w-2/3">
              <p className="text-black font-black italic text-base sm:text-xl uppercase leading-none">
                "THERE'S ONLY ONE WAY OUT OF THE SECTOR. THROUGH THE HIGHWAY RIOT. FLOOD THE ENGINE. LIGHT UP THE TIRES. <span className="text-pink-600">DON'T STOP.</span>"
              </p>
            </div>

            {/* Action Button */}
            <button 
              onClick={() => { playHoverSound(); startGame(); }}
              onMouseEnter={playHoverSound}
              className="mt-8 self-center bg-yellow-400 hover:bg-cyan-400 border-4 border-black p-6 px-16 shadow-[10px_10px_0_0_rgba(0,0,0,1)] hover:shadow-[5px_5px_0_0_rgba(0,0,0,1)] hover:translate-x-[5px] hover:translate-y-[5px] transition-all transform active:scale-95"
            >
               <span className="text-black font-black text-2xl uppercase italic tracking-tighter">IGNITION!</span>
            </button>
          </div>
        </div>
      )}

      {/* GAME OVER SCREEN */}
      {isGameOver && (
        <div id="game-over-screen" className="absolute inset-0 flex flex-col items-center justify-center z-50 bg-black/80 backdrop-blur-md">
          <div id="game-over-divider" className="w-[200px] h-1 bg-gradient-to-r from-transparent via-pink-500 to-transparent mb-12 animate-pulse" />
          <h2 id="game-over-title" className="text-8xl font-black text-white tracking-tighter uppercase italic transform -skew-x-12 mb-2">
            TERMINATED
          </h2>
          <div id="final-score-display" className="text-cyan-400 font-black text-6xl mb-16 tracking-tighter">
            {score.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",")}
          </div>
          
          <div className="flex gap-4">
            <button 
              id="reboot-button"
              onClick={() => { playHoverSound(); startGame(); }}
              onMouseEnter={playHoverSound}
              className="group relative px-12 py-5 pointer-events-auto"
            >
              <div className="absolute inset-0 bg-white group-hover:bg-cyan-400 transition-colors rounded-xl" />
              <span className="relative text-black font-black tracking-[0.5em] text-sm uppercase">Reboot</span>
            </button>

            <button 
              id="menu-button"
              onClick={() => { playHoverSound(); returnToMenu(); }}
              onMouseEnter={playHoverSound}
              className="group relative px-12 py-5 pointer-events-auto"
            >
              <div className="absolute inset-0 border-2 border-white group-hover:bg-white/10 transition-colors rounded-xl" />
              <span className="relative text-white font-black tracking-[0.5em] text-sm uppercase">Menu</span>
            </button>
          </div>

          {score === highScore && score > 0 && (
            <div id="new-record-message" className="mt-10 text-pink-500 font-bold text-sm tracking-[0.4em] animate-pulse">
              NEW SYSTEM RECORD
            </div>
          )}
        </div>
      )}
    </div>
  );
};
