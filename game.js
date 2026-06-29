// GlideGoal Arena - Client-Side P2P Game Engine (PeerJS)
// All physics run on the HOST client; guests send input, receive state.

// ─── Audio Synthesizer ───────────────────────────────────────────────────────
class SoundSynth {
  constructor() { this.ctx = null; this.muted = false; }
  init() {
    if (this.ctx) return;
    try { this.ctx = new (window.AudioContext || window.webkitAudioContext)(); } catch(e) {}
  }
  toggleMute() { this.muted = !this.muted; return this.muted; }
  playKick() {
    if (this.muted || !this.ctx) return;
    const now = this.ctx.currentTime;
    const osc = this.ctx.createOscillator(), gain = this.ctx.createGain();
    osc.type = 'triangle';
    osc.frequency.setValueAtTime(180, now);
    osc.frequency.exponentialRampToValueAtTime(10, now + 0.12);
    gain.gain.setValueAtTime(0.8, now);
    gain.gain.exponentialRampToValueAtTime(0.01, now + 0.12);
    osc.connect(gain); gain.connect(this.ctx.destination);
    osc.start(now); osc.stop(now + 0.12);
  }
  playGoal() {
    if (this.muted || !this.ctx) return;
    this.playWhistle(0.6);
    const now = this.ctx.currentTime;
    const bufferSize = this.ctx.sampleRate * 2.0;
    const buffer = this.ctx.createBuffer(1, bufferSize, this.ctx.sampleRate);
    const data = buffer.getChannelData(0);
    let lastOut = 0.0;
    for (let i = 0; i < bufferSize; i++) {
      const white = Math.random() * 2 - 1;
      data[i] = (lastOut * 0.95 + white * 0.05);
      lastOut = data[i];
    }
    const noise = this.ctx.createBufferSource();
    noise.buffer = buffer;
    const filter = this.ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.setValueAtTime(800, now);
    filter.frequency.exponentialRampToValueAtTime(1500, now + 0.4);
    filter.frequency.exponentialRampToValueAtTime(500, now + 2.0);
    const gain = this.ctx.createGain();
    gain.gain.setValueAtTime(0.01, now);
    gain.gain.linearRampToValueAtTime(0.35, now + 0.2);
    gain.gain.exponentialRampToValueAtTime(0.01, now + 2.0);
    noise.connect(filter); filter.connect(gain); gain.connect(this.ctx.destination);
    noise.start(now);
  }
  playWhistle(duration = 0.35) {
    if (this.muted || !this.ctx) return;
    const now = this.ctx.currentTime;
    const osc1 = this.ctx.createOscillator(), osc2 = this.ctx.createOscillator();
    const gain = this.ctx.createGain();
    osc1.type = 'sine'; osc1.frequency.setValueAtTime(1300, now);
    osc1.frequency.linearRampToValueAtTime(1350, now + duration * 0.2);
    osc1.frequency.linearRampToValueAtTime(1300, now + duration * 0.8);
    osc2.type = 'triangle'; osc2.frequency.setValueAtTime(1304, now);
    gain.gain.setValueAtTime(0.01, now);
    gain.gain.linearRampToValueAtTime(0.15, now + 0.05);
    gain.gain.exponentialRampToValueAtTime(0.01, now + duration);
    osc1.connect(gain); osc2.connect(gain); gain.connect(this.ctx.destination);
    osc1.start(now); osc2.start(now);
    osc1.stop(now + duration + 0.05); osc2.stop(now + duration + 0.05);
  }
}

// ─── Particle System ──────────────────────────────────────────────────────────
class Particle {
  constructor(x, y, color, size, vx, vy, life) {
    this.x=x; this.y=y; this.color=color; this.size=size;
    this.vx=vx; this.vy=vy; this.life=life; this.maxLife=life;
  }
  update() { this.x+=this.vx; this.y+=this.vy; this.vx*=0.96; this.vy*=0.96; this.life--; }
  draw(c) {
    c.save(); c.globalAlpha=this.life/this.maxLife; c.fillStyle=this.color;
    c.beginPath(); c.arc(this.x,this.y,this.size,0,Math.PI*2); c.fill(); c.restore();
  }
}

// ─── Physics Constants ────────────────────────────────────────────────────────
const PITCH_WIDTH  = 1400;
const PITCH_HEIGHT = 850;
const BOUNDS = { xMin:80, xMax:1320, yMin:60, yMax:790 };
const GOAL_BOUNDS = { yMin:320, yMax:530 };

// ─── Global UI & State ────────────────────────────────────────────────────────
const canvas = document.getElementById('gameCanvas');
const ctx    = canvas.getContext('2d');
const sound  = new SoundSynth();

const flagEmojis = {
  BAN:'🇧🇩', ARG:'🇦🇷', BRA:'🇧🇷', GER:'🇩🇪',
  FRA:'🇫🇷', POR:'🇵🇹', ESP:'🇪🇸', ITA:'🇮🇹'
};

let myId        = '';
let playerName  = '';
let roomCode    = '';
let mySlot      = 'unassigned';
let isHost      = false;
let gameActive  = false;
let announcementTimeout = null;

// Render state (synced from host)
let ball      = { x:700, y:425, vx:0, vy:0, radius:18 };
let players   = [];
let scores    = { A:0, B:0 };
let timeRemaining = 60;
let maxPlayers    = 2;
let particles     = [];
let ballTrail     = [];
let netDeformationL = Array(12).fill(0);
let netDeformationR = Array(12).fill(0);

// ─── PeerJS Networking ────────────────────────────────────────────────────────
let peer        = null;   // our PeerJS instance
let hostConn    = null;   // guest → host connection
let guestConns  = [];     // host → all guest connections

// ─── Host-side room state ─────────────────────────────────────────────────────
let roomState = null;
let physicsIntervalId = null;
let timerIntervalId   = null;
let lastTouchedBy     = null;

// ─── Helpers ──────────────────────────────────────────────────────────────────
function generateRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  return Array.from({length:6}, () => chars[Math.floor(Math.random()*chars.length)]).join('');
}

function generatePeerId(code, suffix) {
  // stable peer id so guests can find host by room code
  return `glidegoal-${code}-${suffix}`;
}

function cleanRoomState(state) {
  if (!state) return null;
  return {
    id: state.id,
    players: state.players.map(p => ({
      id:p.id, name:p.name, slot:p.slot,
      x:p.x, y:p.y, vx:p.vx||0, vy:p.vy||0,
      radius:p.radius, isHost:p.isHost,
      flag:p.flag, isAI:p.isAI||false, isSlotAI:p.isSlotAI||false,
      stats:p.stats||{touches:0,goals:0},
      joinedAt: p.joinedAt || Date.now()
    })),
    matchTime:   state.matchTime,
    maxPlayers:  state.maxPlayers,
    aiGoalkeepers:state.aiGoalkeepers,
    ballSpeedLimit:state.ballSpeedLimit,
    timeRemaining:state.timeRemaining,
    scores:       state.scores,
    gameState:    state.gameState,
    ball: { x:state.ball.x, y:state.ball.y, vx:state.ball.vx, vy:state.ball.vy, radius:state.ball.radius }
  };
}

let syncIntervalId = null;
let heartbeatIntervalId = null;
let lastFbTickTime = 0;

function startHeartbeat() {
  if (heartbeatIntervalId) clearInterval(heartbeatIntervalId);
  const sendHb = () => {
    if (roomCode && myId) {
      fbWrite(`live_games/${roomCode}/heartbeats/${myId}`, Date.now());
    }
  };
  sendHb(); // Send IMMEDIATELY on start
  heartbeatIntervalId = setInterval(sendHb, 2500);
}

function startHostSync(code) {
  if (syncIntervalId) clearInterval(syncIntervalId);
  startHeartbeat();
  fbDelete(`live_games/${code}/actions`);
  fbDelete(`live_games/${code}/join_requests`);
  
  syncIntervalId = setInterval(async () => {
    if (!roomCode || !isHost) return;
    
    // 1. Process direct join requests in Firebase
    const joinReqs = await fbRead(`live_games/${code}/join_requests`);
    if (joinReqs && roomState) {
      let reqChanged = false;
      for (const [gId, req] of Object.entries(joinReqs)) {
        fbDelete(`live_games/${code}/join_requests/${gId}`);
        if (gId !== myId) {
          let p = roomState.players.find(pl => pl.id === gId);
          if (!p) {
            roomState.players.push({
              id: gId, name: req.name || 'Guest', slot: 'unassigned',
              x: 0, y: 0, vx: 0, vy: 0, radius: 30, isHost: false, flag: 'BAN',
              stats: { touches: 0, goals: 0 }, joinedAt: Date.now()
            });
            reqChanged = true;
          }
        }
      }
      if (reqChanged) broadcastRoomState();
    }
    
    // 2. Process guest actions posted to Firebase
    const actionsObj = await fbRead(`live_games/${code}/actions`);
    if (actionsObj) {
      for (const [key, item] of Object.entries(actionsObj)) {
        fbDelete(`live_games/${code}/actions/${key}`);
        if (item && item.msg && item.fromId && item.fromId !== myId) {
          processHostMessage(item.msg, item.fromId);
        }
      }
    }

    // 3. Prune disconnected or auto-register missing guests via heartbeats
    if (roomState) {
      const hbs = await fbRead(`live_games/${code}/heartbeats`);
      if (hbs) {
        const now = Date.now();
        let changed = false;
        
        // Auto-register any active guest sending heartbeat if missing in players list
        for (const [gId, hbTime] of Object.entries(hbs)) {
          if (gId !== myId && !gId.startsWith('ai_')) {
            let p = roomState.players.find(pl => pl.id === gId);
            if (!p) {
              roomState.players.push({
                id: gId, name: 'Guest', slot: 'unassigned',
                x: 0, y: 0, vx: 0, vy: 0, radius: 30, isHost: false, flag: 'BAN',
                stats: { touches: 0, goals: 0 }, joinedAt: Date.now()
              });
              changed = true;
            }
          }
        }

        const initialCount = roomState.players.length;
        roomState.players = roomState.players.filter(p => {
          if (p.isHost || p.isAI) return true;
          // Grace period: new joins have 12s immunity
          if (p.joinedAt && (now - p.joinedAt < 12000)) return true;
          const lastHb = hbs[p.id];
          if (lastHb) {
            if (now - lastHb > 12000) {
              changed = true;
              return false;
            }
            return true;
          }
          if (p.joinedAt && (now - p.joinedAt >= 12000)) {
            changed = true;
            return false;
          }
          return true;
        });
        if (changed || roomState.players.length !== initialCount) {
          broadcastRoomState();
        }
      }
    }
  }, 300);
}

function startGuestSync(code) {
  if (syncIntervalId) clearInterval(syncIntervalId);
  startHeartbeat();
  
  syncIntervalId = setInterval(async () => {
    if (!roomCode || isHost) return;
    
    // Read room state & timer
    const stateWrapper = await fbRead(`live_games/${code}/state`);
    if (stateWrapper && stateWrapper.roomState) {
      const rs = stateWrapper.roomState;
      // Ensure self stays present locally in unassigned if Host hasn't synced us yet
      if (myId && !rs.players.some(p => p.id === myId)) {
        rs.players.push({
          id: myId, name: playerName, slot: 'unassigned',
          x: 0, y: 0, vx: 0, vy: 0, radius: 30, isHost: false, flag: 'BAN',
          stats: { touches: 0, goals: 0 }, joinedAt: Date.now()
        });
      }
      handleMessage({ type: 'room-state-updated', roomState: rs });
      if (stateWrapper.event && stateWrapper.event !== 'room-state-updated') {
        handleMessage(stateWrapper.eventData || { type: stateWrapper.event });
      }
    }

    // Read high-speed physics ticks during live match
    if (gameActive) {
      const tickMsg = await fbRead(`live_games/${code}/tick`);
      if (tickMsg && tickMsg.type === 'physics-tick') {
        handleMessage(tickMsg);
      }
    }
  }, 250);
}

function broadcastToAll(msg) {
  // 1. WebRTC DataChannel send (instant 60 FPS when connected)
  guestConns.forEach(c => { try { c.send(msg); } catch(e){} });

  // 2. Firebase Cloud Sync (guarantees cross-ISP connectivity)
  if (roomCode && isHost) {
    if (msg.type === 'physics-tick') {
      const now = Date.now();
      if (now - lastFbTickTime > 70) {
        lastFbTickTime = now;
        fbWrite(`live_games/${roomCode}/tick`, msg);
      }
    } else {
      // Full state sync for timer, lobby, goals, match start, etc.
      fbWrite(`live_games/${roomCode}/state`, {
        type: 'room-state-updated',
        roomState: cleanRoomState(roomState),
        event: msg.type,
        eventData: msg
      });
    }
  }
}

function sendToHost(msg) {
  if (!msg.name && typeof playerName !== 'undefined' && playerName) {
    msg.name = playerName;
  }
  // 1. WebRTC DataChannel send
  if (hostConn && hostConn.open) try { hostConn.send(msg); } catch(e){}
  // 2. Firebase Cloud relay
  if (roomCode) {
    fetch(`${FIREBASE_DB_URL}/live_games/${roomCode}/actions.json`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ msg, fromId: myId })
    }).catch(()=>{});
  }
}

// ─── Slot Validation ──────────────────────────────────────────────────────────
function isValidSlot(slot, maxPl, aiGK) {
  if (slot === 'unassigned') return true;
  if (aiGK) {
    if (slot === 'teamA_gk' || slot === 'teamB_gk') return false;
    if (maxPl === 2)  return slot==='teamA_striker'||slot==='teamB_striker';
    if (maxPl === 4)  return ['teamA_striker','teamA_midfielder','teamB_striker','teamB_midfielder'].includes(slot);
    if (maxPl === 6)  return ['teamA_striker','teamA_midfielder','teamA_defender','teamB_striker','teamB_midfielder','teamB_defender'].includes(slot);
    if (maxPl >= 8)   return ['teamA_striker','teamA_midfielder','teamA_defender','teamA_forward','teamB_striker','teamB_midfielder','teamB_defender','teamB_forward'].includes(slot);
  } else {
    if (slot==='teamA_forward'||slot==='teamB_forward') return false;
    if (maxPl === 2)  return slot==='teamA_striker'||slot==='teamB_striker';
    if (maxPl === 4)  return ['teamA_striker','teamA_gk','teamB_striker','teamB_gk'].includes(slot);
    if (maxPl === 6)  return ['teamA_striker','teamA_gk','teamA_midfielder','teamB_striker','teamB_gk','teamB_midfielder'].includes(slot);
    if (maxPl >= 8)   return ['teamA_striker','teamA_gk','teamA_midfielder','teamA_defender','teamB_striker','teamB_gk','teamB_midfielder','teamB_defender'].includes(slot);
  }
  return false;
}

function getStartPos(slot) {
  const map = {
    teamA_striker:{x:600,y:425},  teamA_gk:{x:180,y:425},
    teamA_midfielder:{x:450,y:250},teamA_defender:{x:320,y:600},
    teamA_forward:{x:450,y:600},
    teamB_striker:{x:800,y:425},  teamB_gk:{x:1220,y:425},
    teamB_midfielder:{x:950,y:600},teamB_defender:{x:1080,y:250},
    teamB_forward:{x:950,y:250}
  };
  return map[slot] || {x:0,y:0};
}

// ─── Host-side Physics ────────────────────────────────────────────────────────
function updateAiGoalkeepers(rs) {
  const b = rs.ball;
  rs.players.forEach(p => {
    if (!p.isAI) return;
    let tx, ty, speedLimit = 8.5;
    if (p.slot === 'teamA_gk') {
      const close = b.x < 350 && b.y >= 200 && b.y <= 650;
      tx = close ? Math.max(120,Math.min(240,b.x)) : 150;
      ty = Math.max(290,Math.min(560, 425 + (b.y-425)*0.45));
    } else if (p.slot === 'teamB_gk') {
      const close = b.x > 1050 && b.y >= 200 && b.y <= 650;
      tx = close ? Math.max(1160,Math.min(1280,b.x)) : 1250;
      ty = Math.max(290,Math.min(560, 425 + (b.y-425)*0.45));
    } else { return; }
    const dx=tx-p.x, dy=ty-p.y, dist=Math.sqrt(dx*dx+dy*dy);
    if (dist > 0) {
      const s = dist > speedLimit ? speedLimit : dist;
      p.vx = (dx/dist)*s; p.vy = (dy/dist)*s;
    } else { p.vx=0; p.vy=0; }
    p.x += p.vx; p.y += p.vy;
  });
}

function updateOutfieldAI(rs) {
  const b = rs.ball;
  rs.players.forEach(p => {
    if (!p.isAI || p.slot==='teamA_gk' || p.slot==='teamB_gk') return;
    const isA = p.slot.startsWith('teamA');
    const speed = 5.5;
    let tx, ty;
    if (p.slot.includes('striker'))       { tx=b.x; ty=b.y; }
    else if (p.slot.includes('forward'))  { tx=isA?Math.max(b.x,700):Math.min(b.x,700); ty=b.y; }
    else if (p.slot.includes('midfielder')){ const d=Math.hypot(b.x-p.x,b.y-p.y); tx=d<350?b.x:PITCH_WIDTH/2; ty=d<350?b.y:PITCH_HEIGHT/2; }
    else if (p.slot.includes('defender')) { const defX=isA?320:PITCH_WIDTH-320; const inZ=isA?b.x<480:b.x>PITCH_WIDTH-480; tx=inZ?b.x:defX; ty=inZ?b.y:PITCH_HEIGHT/2; }
    else return;
    tx=Math.max(BOUNDS.xMin+5,Math.min(BOUNDS.xMax-5,tx));
    ty=Math.max(BOUNDS.yMin+5,Math.min(BOUNDS.yMax-5,ty));
    const dx=tx-p.x, dy=ty-p.y, dist=Math.hypot(dx,dy);
    if (dist>2){ const ms=Math.min(speed,dist); p.vx=(dx/dist)*ms; p.vy=(dy/dist)*ms; p.x+=p.vx; p.y+=p.vy; }
    else { p.vx=0; p.vy=0; }
  });
}

function hostResetPlay(rs, scoringTeam) {
  if (lastTouchedBy) {
    const scorer = rs.players.find(p=>p.id===lastTouchedBy);
    if (scorer) { if(!scorer.stats)scorer.stats={touches:0,goals:0}; scorer.stats.goals++; }
    lastTouchedBy = null;
  }
  rs.ball.x=PITCH_WIDTH/2; rs.ball.y=PITCH_HEIGHT/2; rs.ball.vx=0; rs.ball.vy=0;
  rs.players.forEach(p => { const pos=getStartPos(p.slot); p.x=pos.x; p.y=pos.y; p.vx=0; p.vy=0; });
  const msg = { type:'goal-scored', scoringTeam, scores:rs.scores };
  broadcastToAll(msg);
  handleMessage(msg); // host handles locally too
}

function hostEndGame(rs) {
  rs.gameState = 'gameover';
  clearInterval(physicsIntervalId); clearInterval(timerIntervalId);
  physicsIntervalId=null; timerIntervalId=null;
  const fullStats = rs.players.filter(p=>p.slot!=='unassigned').map(p=>({
    name:p.name, slot:p.slot, isAI:p.isAI||false,
    flag:p.flag||'BAN', stats:p.stats||{touches:0,goals:0}
  }));
  rs.players = rs.players.filter(p=>!p.isAI);
  const msg = { type:'game-over', scores:rs.scores, players:fullStats };
  broadcastToAll(msg);
  handleMessage(msg);
}

function hostPhysicsTick(rs) {
  if (rs.gameState !== 'playing') return;
  updateAiGoalkeepers(rs);
  updateOutfieldAI(rs);
  const b = rs.ball;
  b.x += b.vx; b.y += b.vy;
  b.vx *= b.damping; b.vy *= b.damping;
  if (Math.abs(b.vx) < 0.05) b.vx = 0;
  if (Math.abs(b.vy) < 0.05) b.vy = 0;
  // Top/bottom walls
  if (b.y - b.radius < BOUNDS.yMin) { b.y = BOUNDS.yMin + b.radius; b.vy = -b.vy*0.75; }
  else if (b.y + b.radius > BOUNDS.yMax) { b.y = BOUNDS.yMax - b.radius; b.vy = -b.vy*0.75; }
  // Goal & side walls
  const inGoalY = b.y >= GOAL_BOUNDS.yMin && b.y <= GOAL_BOUNDS.yMax;
  if (inGoalY) {
    if (b.x - b.radius < BOUNDS.xMin - 20) { rs.scores.B++; hostResetPlay(rs,'B'); return; }
    else if (b.x + b.radius > BOUNDS.xMax + 20) { rs.scores.A++; hostResetPlay(rs,'A'); return; }
  } else {
    if (b.x - b.radius < BOUNDS.xMin) { b.x=BOUNDS.xMin+b.radius; b.vx=-b.vx*0.75; }
    else if (b.x + b.radius > BOUNDS.xMax) { b.x=BOUNDS.xMax-b.radius; b.vx=-b.vx*0.75; }
  }
  // Player collisions
  rs.players.forEach(p => {
    if (p.slot==='unassigned') return;
    const dx=b.x-p.x, dy=b.y-p.y, dist=Math.hypot(dx,dy);
    const minDist=b.radius+p.radius;
    if (dist < minDist && dist > 0) {
      if (!p.stats) p.stats={touches:0,goals:0};
      p.stats.touches++; lastTouchedBy=p.id;
      const overlap=minDist-dist, nx=dx/dist, ny=dy/dist;
      b.x+=nx*overlap; b.y+=ny*overlap;
      const rvx=b.vx-p.vx, rvy=b.vy-p.vy;
      const vaN=rvx*nx+rvy*ny;
      if (vaN < 0) { const imp=-(1+0.6)*vaN; b.vx+=nx*imp; b.vy+=ny*imp; }
      const ps=Math.hypot(p.vx,p.vy), pm=ps>2?0.35:0.15;
      b.vx+=nx*(2.0+ps*pm); b.vy+=ny*(2.0+ps*pm);
      const bspd=Math.hypot(b.vx,b.vy), sl=rs.ballSpeedLimit||20;
      if (bspd>sl){ b.vx=(b.vx/bspd)*sl; b.vy=(b.vy/bspd)*sl; }
    }
  });
  // Broadcast frame
  const pStates = rs.players.map(p=>({ id:p.id, name:p.name, slot:p.slot, x:p.x, y:p.y, vx:p.vx||0, vy:p.vy||0, flag:p.flag }));
  const tickMsg = { type:'physics-tick', ball:{x:b.x,y:b.y,vx:b.vx,vy:b.vy}, players:pStates, scores:rs.scores };
  broadcastToAll(tickMsg);
  handleMessage(tickMsg); // host renders locally
}

// ─── Message Router (used by BOTH host and guest) ────────────────────────────
function handleMessage(msg) {
  switch(msg.type) {
    case 'room-state-updated': {
      const rs = msg.roomState;
      maxPlayers = rs.maxPlayers;
      const me = rs.players.find(p=>p.id===myId);
      if (me) { isHost=me.isHost; mySlot=me.slot; }
      const hasA = rs.players.some(p=>p.slot.startsWith('teamA'));
      const hasB = rs.players.some(p=>p.slot.startsWith('teamB'));
      const startBtn = document.getElementById('startMatchBtn');
      if (isHost) {
        startBtn.style.display='block'; startBtn.disabled=!(hasA&&hasB);
        ['matchTimeSelect','maxPlayersSelect','aiGoalkeepersSelect','ballSpeedSelect'].forEach(id=>document.getElementById(id).disabled=false);
      } else {
        startBtn.style.display='none';
        ['matchTimeSelect','maxPlayersSelect','aiGoalkeepersSelect','ballSpeedSelect'].forEach(id=>document.getElementById(id).disabled=true);
      }
      document.getElementById('matchTimeSelect').value    = rs.matchTime.toString();
      document.getElementById('maxPlayersSelect').value   = rs.maxPlayers.toString();
      document.getElementById('aiGoalkeepersSelect').value= rs.aiGoalkeepers.toString();
      document.getElementById('ballSpeedSelect').value    = rs.ballSpeedLimit.toString();
      updateWaitingRoomUI(rs);
      break;
    }
    case 'match-started': {
      const rs = msg.roomState;
      gameActive=true; scores=rs.scores; timeRemaining=rs.matchTime;
      ball=rs.ball; players=rs.players;
      document.getElementById('scoreA').innerText='0';
      document.getElementById('scoreB').innerText='0';
      updateTimerUI(timeRemaining);
      document.getElementById('waitingRoom').classList.add('hidden');
      document.getElementById('gameOverPanel').classList.add('hidden');
      document.getElementById('gameHUD').classList.remove('hidden');
      document.getElementById('playerStatsPanel').classList.remove('hidden');
      canvas.classList.remove('hidden');
      particles=[]; ballTrail=[]; netDeformationL.fill(0); netDeformationR.fill(0);
      resizeCanvas(); sound.playWhistle();
      break;
    }
    case 'physics-tick': {
      if (!gameActive) return;
      const speed = Math.hypot(msg.ball.vx, msg.ball.vy);
      if (speed > 1.8) {
        ballTrail.push({x:msg.ball.x,y:msg.ball.y});
        if (ballTrail.length>8) ballTrail.shift();
        if (Math.random()<0.3) particles.push(new Particle(msg.ball.x,msg.ball.y,'rgba(255,255,255,0.15)',Math.random()*2+1,-msg.ball.vx*0.2,-msg.ball.vy*0.2,15));
      } else { ballTrail.shift(); }
      const oldSpeed = Math.hypot(ball.vx, ball.vy);
      if (speed > oldSpeed+1.2) sound.playKick();
      ball={...ball,...msg.ball}; players=msg.players; scores=msg.scores;
      document.getElementById('scoreA').innerText=scores.A;
      document.getElementById('scoreB').innerText=scores.B;
      for (let i=0;i<12;i++){ netDeformationL[i]*=0.88; netDeformationR[i]*=0.88; }
      updatePlayerStatsPanel();
      break;
    }
    case 'goal-scored': {
      scores=msg.scores;
      const px=msg.scoringTeam==='A'?BOUNDS.xMax+10:BOUNDS.xMin-10, py=PITCH_HEIGHT/2;
      const color=msg.scoringTeam==='A'?'var(--accent-blue)':'var(--accent-red)';
      if (msg.scoringTeam==='A') netDeformationR.fill(16); else netDeformationL.fill(-16);
      triggerGoalExplosion(px,py,color); showAnnouncement('GOAL!'); sound.playGoal();
      break;
    }
    case 'timer-updated': {
      timeRemaining=msg.timeRemaining; updateTimerUI(timeRemaining);
      break;
    }
    case 'game-over': {
      gameActive=false;
      canvas.classList.add('hidden');
      document.getElementById('gameHUD').classList.add('hidden');
      document.getElementById('playerStatsPanel').classList.add('hidden');
      document.getElementById('finalScoreA').innerText=msg.scores.A;
      document.getElementById('finalScoreB').innerText=msg.scores.B;
      const verdict=document.getElementById('matchVerdict');
      if (msg.scores.A>msg.scores.B){ verdict.innerText='🏆 Team A Wins!'; verdict.style.color='var(--accent-blue)'; }
      else if (msg.scores.B>msg.scores.A){ verdict.innerText='🏆 Team B Wins!'; verdict.style.color='var(--accent-red)'; }
      else { verdict.innerText="It's a Draw!"; verdict.style.color='#fff'; }
      const statsList=document.getElementById('gameoverStatsList'); statsList.innerHTML='';
      const sorted=[...msg.players].sort((a,b)=>{ const tA=a.slot.startsWith('teamA')?0:1,tB=b.slot.startsWith('teamA')?0:1; if(tA!==tB)return tA-tB; return (b.stats?.goals||0)-(a.stats?.goals||0); });
      sorted.forEach(p=>{
        const isA=p.slot.startsWith('teamA');
        const teamColor=isA?'var(--accent-blue)':'var(--accent-red)';
        const teamLabel=isA?'A':'B';
        let roleLabel='ST';
        if(p.slot.includes('gk'))roleLabel='GK';
        else if(p.slot.includes('midfielder'))roleLabel='MID';
        else if(p.slot.includes('defender'))roleLabel='DEF';
        else if(p.slot.includes('forward'))roleLabel='FWD';
        const row=document.createElement('div'); row.className=`gameover-stat-row ${isA?'team-a-row':'team-b-row'}`;
        row.innerHTML=`<div class="gos-name"><span class="gos-team-dot" style="background:${teamColor}"></span><span class="gos-role-badge" style="color:${teamColor}">${roleLabel}</span><span class="gos-player-name">${p.name}${p.isAI?' 🤖':''}</span></div><div class="gos-team-cell"><span class="gos-team-badge" style="color:${teamColor};border-color:${teamColor}">${teamLabel}</span></div><div class="gos-stat-cell"><span class="gos-val">${p.stats?.goals||0}</span><span class="gos-lbl">Goals</span></div><div class="gos-stat-cell"><span class="gos-val">${p.stats?.touches||0}</span><span class="gos-lbl">Touches</span></div>`;
        statsList.appendChild(row);
      });
      document.getElementById('gameOverPanel').classList.remove('hidden');
      sound.playWhistle(0.85);
      break;
    }
    case 'slot-error': { alert(msg.message); break; }
    case 'error-msg':  { document.getElementById('lobbyError').innerText=msg.message; break; }
  }
}

// ─── HOST Message Processor ───────────────────────────────────────────────────
function processHostMessage(msg, fromId) {
  const rs = roomState;
  if (!rs) return;

  switch(msg.type) {
    case 'select-slot': {
      const slot=msg.slot;
      if (!isValidSlot(slot, rs.maxPlayers, rs.aiGoalkeepers)) {
        const errMsg={type:'slot-error',message:'This slot is disabled or controlled by AI!'};
        if (fromId===myId) handleMessage(errMsg);
        else { const c=guestConns.find(c=>c.peer===fromId); if(c)c.send(errMsg); }
        return;
      }
      if (slot!=='unassigned' && rs.players.some(p=>p.slot===slot)) {
        const errMsg={type:'slot-error',message:'This slot is already taken!'};
        if (fromId===myId) handleMessage(errMsg);
        else { const c=guestConns.find(c=>c.peer===fromId); if(c)c.send(errMsg); }
        return;
      }
      let player=rs.players.find(p=>p.id===fromId);
      if (!player) {
        player = {
          id: fromId, name: msg.name || 'Guest', slot: 'unassigned',
          x:0, y:0, vx:0, vy:0, radius:30, isHost:false, flag:'BAN',
          stats:{touches:0,goals:0}, joinedAt: Date.now()
        };
        rs.players.push(player);
      }
      player.slot=slot;
      player.flag=slot.startsWith('teamA')?'ARG':slot.startsWith('teamB')?'BRA':'BAN';
      const pos=getStartPos(slot); player.x=pos.x; player.y=pos.y;
      broadcastRoomState();
      break;
    }
    case 'select-flag': {
      let player=rs.players.find(p=>p.id===fromId);
      if (!player) {
        player = { id: fromId, name: msg.name || 'Guest', slot:'unassigned', x:0, y:0, vx:0, vy:0, radius:30, isHost:false, flag:msg.flag, stats:{touches:0,goals:0}, joinedAt: Date.now() };
        rs.players.push(player);
      } else { player.flag=msg.flag; }
      broadcastRoomState();
      break;
    }
    case 'update-match-time': {
      const host=rs.players.find(p=>p.id===fromId);
      if (!host||!host.isHost) return;
      rs.matchTime=parseInt(msg.matchTime,10); rs.timeRemaining=rs.matchTime;
      broadcastRoomState(); break;
    }
    case 'update-max-players': {
      const host=rs.players.find(p=>p.id===fromId);
      if (!host||!host.isHost) return;
      const count=parseInt(msg.maxPlayers,10); rs.maxPlayers=count;
      rs.players.forEach(p=>{ if(!isValidSlot(p.slot,count,rs.aiGoalkeepers)){p.slot='unassigned';p.x=0;p.y=0;} });
      broadcastRoomState(); break;
    }
    case 'update-ai-goalkeepers': {
      const host=rs.players.find(p=>p.id===fromId);
      if (!host||!host.isHost) return;
      const enabled=(msg.aiGoalkeepers==='true'||msg.aiGoalkeepers===true);
      rs.aiGoalkeepers=enabled;
      if (enabled) rs.players.forEach(p=>{ if(p.slot==='teamA_gk'||p.slot==='teamB_gk'){p.slot='unassigned';p.x=0;p.y=0;} });
      broadcastRoomState(); break;
    }
    case 'update-ball-speed': {
      const host=rs.players.find(p=>p.id===fromId);
      if (!host||!host.isHost) return;
      rs.ballSpeedLimit=parseInt(msg.ballSpeed,10)||20;
      broadcastRoomState(); break;
    }
    case 'add-ai-slot-player': {
      const host=rs.players.find(p=>p.id===fromId);
      if (!host||!host.isHost) return;
      const slot=msg.slot;
      if (rs.players.some(p=>p.slot===slot)) return;
      const isA=slot.startsWith('teamA');
      const pos=getStartPos(slot);
      const bots=['Bolt','Nova','Viper','Storm','Flash','Titan','Apex','Flux'];
      rs.players.push({ id:`ai_${slot}_${Date.now()}`, name:`🤖 ${bots[Math.floor(Math.random()*bots.length)]}`, slot, x:pos.x, y:pos.y, vx:0, vy:0, radius:30, isHost:false, flag:isA?'ARG':'BRA', isAI:true, isSlotAI:true, stats:{touches:0,goals:0} });
      broadcastRoomState(); break;
    }
    case 'remove-ai-slot-player': {
      const host=rs.players.find(p=>p.id===fromId);
      if (!host||!host.isHost) return;
      rs.players=rs.players.filter(p=>!(p.slot===msg.slot&&p.isSlotAI));
      broadcastRoomState(); break;
    }
    case 'start-match': {
      const host=rs.players.find(p=>p.id===fromId);
      if (!host||!host.isHost) return;
      rs.gameState='playing'; rs.timeRemaining=rs.matchTime;
      rs.scores={A:0,B:0}; rs.ball.x=PITCH_WIDTH/2; rs.ball.y=PITCH_HEIGHT/2;
      rs.ball.vx=0; rs.ball.vy=0; lastTouchedBy=null;
      rs.players.forEach(p=>{ p.stats={touches:0,goals:0}; });
      // Spawn AI goalkeepers
      if (rs.aiGoalkeepers) {
        if (!rs.players.some(p=>p.id==='ai_gk_a')) rs.players.push({ id:'ai_gk_a', name:'AI GK A', slot:'teamA_gk', x:180, y:425, vx:0, vy:0, radius:30, isHost:false, flag:'ARG', isAI:true, stats:{touches:0,goals:0} });
        if (!rs.players.some(p=>p.id==='ai_gk_b')) rs.players.push({ id:'ai_gk_b', name:'AI GK B', slot:'teamB_gk', x:1220, y:425, vx:0, vy:0, radius:30, isHost:false, flag:'BRA', isAI:true, stats:{touches:0,goals:0} });
      }
      rs.players.forEach(p=>{ const pos=getStartPos(p.slot); p.x=pos.x; p.y=pos.y; p.vx=0; p.vy=0; });
      const startMsg={type:'match-started', roomState:cleanRoomState(rs)};
      broadcastToAll(startMsg); handleMessage(startMsg);
      // Start physics & timer
      if (physicsIntervalId) clearInterval(physicsIntervalId);
      physicsIntervalId=setInterval(()=>hostPhysicsTick(rs),16);
      if (timerIntervalId) clearInterval(timerIntervalId);
      timerIntervalId=setInterval(()=>{
        rs.timeRemaining--;
        const tMsg={type:'timer-updated', timeRemaining:rs.timeRemaining};
        broadcastToAll(tMsg); handleMessage(tMsg);
        if (rs.timeRemaining<=0) hostEndGame(rs);
      },1000);
      break;
    }
    case 'move-disc': {
      if (rs.gameState!=='playing') return;
      const player=rs.players.find(p=>p.id===fromId);
      if (player && player.slot!=='unassigned') {
        player.vx=msg.x-player.x; player.vy=msg.y-player.y;
        player.x=msg.x; player.y=msg.y;
      }
      break;
    }
    case 'guest-join': {
      let player = rs.players.find(p => p.id === fromId);
      if (!player) {
        player = {
          id: fromId,
          name: msg.name || 'Guest',
          slot: 'unassigned',
          x: 0, y: 0, vx: 0, vy: 0,
          radius: 30, isHost: false, flag: 'BAN',
          stats: { touches: 0, goals: 0 },
          joinedAt: Date.now()
        };
        rs.players.push(player);
      } else if (msg.name && player.name !== msg.name) {
        player.name = msg.name;
      }
      broadcastRoomState();
      break;
    }
  }
}

function broadcastRoomState() {
  const msg={type:'room-state-updated', roomState:cleanRoomState(roomState)};
  broadcastToAll(msg);
  handleMessage(msg); // host also updates locally
}

// ─── Firebase Signaling (REST API — no SDK, no backend needed) ───────────────
// Firebase Realtime Database is globally distributed (Google infra).
// It stores just the host's PeerJS ID so guests can find them from ANY network.
//
// HOW TO SET UP (one-time, 3 minutes):
//  1. Go to https://console.firebase.google.com
//  2. Click "Add project" → name it (e.g. glidegoal) → Continue → Create
//  3. Left menu: Build → Realtime Database → Create database
//  4. Choose any region → Start in TEST MODE → Enable
//  5. Copy the URL shown (e.g. https://glidegoal-xxxxx-default-rtdb.firebaseio.com)
//  6. Paste it below and tell the developer to push the change.

const FIREBASE_DB_URL = 'https://glide-goal-arena-default-rtdb.firebaseio.com';

async function fbWrite(path, data) {
  try {
    const r = await fetch(`${FIREBASE_DB_URL}/${path}.json`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    });
    return r.ok;
  } catch(e) { console.error('FB write error', e); return false; }
}

async function fbPatch(path, data) {
  try {
    const r = await fetch(`${FIREBASE_DB_URL}/${path}.json`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    });
    return r.ok;
  } catch(e) { return false; }
}

async function fbRead(path) {
  try {
    const r = await fetch(`${FIREBASE_DB_URL}/${path}.json`);
    if (!r.ok) return null;
    return await r.json();
  } catch(e) { console.error('FB read error', e); return null; }
}

async function fbDelete(path) {
  try { await fetch(`${FIREBASE_DB_URL}/${path}.json`, { method: 'DELETE' }); }
  catch(e) {}
}

function getFormattedDateParts() {
  const now = new Date();
  const year = now.getFullYear().toString();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  const timeStr = now.toLocaleTimeString();
  const dateKey = `${year}-${month}-${day}`;
  return { year, month, day, timeStr, dateKey };
}

// ─── ICE Servers: Global STUN + Multi-region TURN Relays ──────────────────────
// High-availability TURN servers enable P2P connection across different ISPs & mobile 4G/5G networks.
const ICE_SERVERS = {
  iceServers: [
    // Google STUN
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun2.l.google.com:19302' },
    { urls: 'stun:stun3.l.google.com:19302' },
    { urls: 'stun:stun4.l.google.com:19302' },
    // Cloudflare & Mozilla STUN
    { urls: 'stun:stun.cloudflare.com:3478' },
    { urls: 'stun:stun.services.mozilla.com:3478' },
    // Metered Global Multi-Region TURN Relays (TCP + UDP ports 80, 443)
    { urls: 'stun:stun.relay.metered.ca:80' },
    { urls: 'turn:global.relay.metered.ca:80', username: 'openrelayproject', credential: 'openrelayproject' },
    { urls: 'turn:global.relay.metered.ca:443', username: 'openrelayproject', credential: 'openrelayproject' },
    { urls: 'turn:global.relay.metered.ca:443?transport=tcp', username: 'openrelayproject', credential: 'openrelayproject' },
    { urls: 'turn:standard.relay.metered.ca:80', username: 'openrelayproject', credential: 'openrelayproject' },
    { urls: 'turn:standard.relay.metered.ca:443', username: 'openrelayproject', credential: 'openrelayproject' },
    { urls: 'turn:standard.relay.metered.ca:443?transport=tcp', username: 'openrelayproject', credential: 'openrelayproject' }
  ],
  iceCandidatePoolSize: 10
};

function initPeer(id) {
  return new Promise((resolve) => {
    let resolved = false;
    const timer = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        resolve(null);
      }
    }, 2000);

    try {
      const p = new Peer(id, { config: ICE_SERVERS, debug: 0 });
      p.on('open', (openId) => {
        if (!resolved) {
          resolved = true;
          clearTimeout(timer);
          resolve(p);
        }
      });
      p.on('error', (err) => {
        if (!resolved) {
          resolved = true;
          clearTimeout(timer);
          resolve(null);
        }
      });
    } catch(e) {
      if (!resolved) {
        resolved = true;
        clearTimeout(timer);
        resolve(null);
      }
    }
  });
}

function attachGuestConn(conn) {
  const guestId = conn.metadata?.guestId || conn.peer;
  conn.on('open', () => {
    if (!guestConns.includes(conn)) guestConns.push(conn);
    const rs = roomState;
    if (!rs) return;
    let p = rs.players.find(pl => pl.id === guestId);
    if (!p) {
      rs.players.push({
        id: guestId, name: conn.metadata?.name || 'Guest',
        slot:'unassigned', x:0, y:0, vx:0, vy:0,
        radius:30, isHost:false, flag:'BAN',
        stats:{touches:0,goals:0}, joinedAt: Date.now()
      });
      broadcastRoomState();
    }
  });
  conn.on('data', (msg) => {
    processHostMessage(msg, guestId);
  });
  conn.on('close', () => {
    guestConns = guestConns.filter(c => c !== conn);
  });
}

// ─── Screen Navigation & UI ───────────────────────────────────────────────────
function showLobbySelect() {
  const name = document.getElementById('playerNameInput').value.trim();
  if (!name) { alert('Please enter a username.'); return; }
  playerName = name;
  document.getElementById('loginMenu').classList.add('hidden');
  document.getElementById('lobbyMenu').classList.remove('hidden');
  sound.init();
}

function backToLogin() {
  document.getElementById('lobbyMenu').classList.add('hidden');
  document.getElementById('loginMenu').classList.remove('hidden');
}

async function createRoom() {
  document.getElementById('lobbyError').innerText = '⏳ Creating room...';
  roomCode = generateRoomCode();

  peer = await initPeer(`gg-${roomCode}-${Date.now()}`);
  if (!peer) {
    document.getElementById('lobbyError').innerText = '❌ Failed to create peer. Try again.';
    return;
  }
  isHost = true;
  myId = peer.id;

  const { year, month, day, timeStr, dateKey } = getFormattedDateParts();
  const roomPath = `rooms/${year}/${month}/${day}/${roomCode}`;

  const roomData = {
    host: playerName,
    hostPeerId: myId,
    code: roomCode,
    created_at: timeStr,
    status: 'active'
  };

  // 1. Write structured log in Firebase by Year > Month > Date
  const ok1 = await fbWrite(roomPath, roomData);

  // 2. Write quick index for guest lookup
  const ok2 = await fbWrite(`room_index/${roomCode}`, {
    hostPeerId: myId,
    roomPath: roomPath,
    host: playerName
  });

  if (!ok1 && !ok2) {
    document.getElementById('lobbyError').innerText = '❌ Firebase error. Check connection.';
    return;
  }

  // 3. Update dynamic analytics
  (async () => {
    const total = (await fbRead('analytics/total_rooms_all_time')) || 0;
    await fbWrite('analytics/total_rooms_all_time', total + 1);

    const todayTotal = (await fbRead(`analytics/daily/${dateKey}/rooms_created`)) || 0;
    await fbWrite(`analytics/daily/${dateKey}/rooms_created`, todayTotal + 1);
  })();

  document.getElementById('lobbyError').innerText = '';
  roomState = {
    id: roomCode,
    players: [{
      id: myId, name: playerName, slot:'unassigned',
      x:0, y:0, vx:0, vy:0, radius:30, isHost:true, flag:'BAN',
      stats:{touches:0,goals:0}
    }],
    matchTime:60, maxPlayers:2, aiGoalkeepers:false,
    ballSpeedLimit:20, timeRemaining:60,
    scores:{A:0,B:0}, gameState:'lobby',
    ball:{x:PITCH_WIDTH/2, y:PITCH_HEIGHT/2, vx:0, vy:0, radius:18, damping:0.985}
  };

  peer.on('connection', (conn) => { attachGuestConn(conn); });
  startHostSync(roomCode);
  broadcastRoomState();

  window.addEventListener('beforeunload', () => {
    if (syncIntervalId) clearInterval(syncIntervalId);
    fbDelete(`room_index/${roomCode}`);
    fbDelete(`live_games/${roomCode}`);
    fbPatch(roomPath, { status: 'closed' });
  });

  document.getElementById('displayRoomCode').innerText = roomCode;
  document.getElementById('matchTimeSelect').disabled=false;
  document.getElementById('maxPlayersSelect').disabled=false;
  document.getElementById('aiGoalkeepersSelect').disabled=false;
  document.getElementById('ballSpeedSelect').disabled=false;
  document.getElementById('startMatchBtn').style.display='block';
  updateWaitingRoomUI(roomState);
  document.getElementById('lobbyMenu').classList.add('hidden');
  document.getElementById('waitingRoom').classList.remove('hidden');
}

async function joinRoom() {
  const code = document.getElementById('roomCodeInput').value.trim().toUpperCase();
  if (code.length !== 6) { document.getElementById('lobbyError').innerText='Enter a valid 6-letter room code.'; return; }
  roomCode = code;

  document.getElementById('lobbyError').innerText = '🔄 Finding room...';
  
  // Multi-stage fallback lookup
  let indexData = await fbRead(`room_index/${code}`);
  let hostPeerId = indexData?.hostPeerId;

  if (!hostPeerId) {
    const { year, month, day } = getFormattedDateParts();
    const directData = await fbRead(`rooms/${year}/${month}/${day}/${code}`);
    hostPeerId = directData?.hostPeerId;
  }

  if (!hostPeerId) {
    const legacyData = await fbRead(`active_rooms/${code}`);
    hostPeerId = legacyData?.hostPeerId;
  }

  if (!hostPeerId) {
    document.getElementById('lobbyError').innerText = '❌ Room not found. Check the code and make sure host is online.';
    return;
  }

  document.getElementById('lobbyError').innerText = '🔄 Joining room...';
  myId = `gg-guest-${Date.now()}-${Math.floor(Math.random()*10000)}`;
  peer = await initPeer(myId);
  isHost = false;

  // Immediately fetch initial state so Team A / Team B slots render INSTANTLY
  const initialState = await fbRead(`live_games/${code}/state`);
  if (initialState && initialState.roomState) {
    if (!initialState.roomState.players.some(p => p.id === myId)) {
      initialState.roomState.players.push({
        id: myId, name: playerName, slot: 'unassigned',
        x: 0, y: 0, vx: 0, vy: 0, radius: 30, isHost: false, flag: 'BAN',
        stats: { touches: 0, goals: 0 }, joinedAt: Date.now()
      });
    }
    handleMessage(initialState);
  }

  // Send join request via Firebase cloud relay & direct join node FIRST
  fbWrite(`live_games/${code}/join_requests/${myId}`, { name: playerName, joinedAt: Date.now() });
  sendToHost({ type:'guest-join', name: playerName });

  startGuestSync(code);
  document.getElementById('lobbyError').innerText='';
  document.getElementById('displayRoomCode').innerText = code;
  document.getElementById('matchTimeSelect').disabled=true;
  document.getElementById('maxPlayersSelect').disabled=true;
  document.getElementById('aiGoalkeepersSelect').disabled=true;
  document.getElementById('ballSpeedSelect').disabled=true;
  document.getElementById('startMatchBtn').style.display='none';
  document.getElementById('lobbyMenu').classList.add('hidden');
  document.getElementById('waitingRoom').classList.remove('hidden');

  // Parallel WebRTC connection attempt
  if (peer && hostPeerId) {
    const conn = peer.connect(hostPeerId, {
      metadata: { name: playerName, guestId: myId },
      reliable: true,
      serialization: 'json',
      config: ICE_SERVERS
    });
    hostConn = conn;
    conn.on('open', () => {
      conn.send({ type:'guest-join', name: playerName });
    });
    conn.on('data', (msg) => { handleMessage(msg); });
  }
}



// ─── Game Controls → route to host ───────────────────────────────────────────
function changeFlag(flag) {
  const msg={type:'select-flag',flag};
  if (isHost) processHostMessage(msg,myId); else sendToHost(msg);
}
function changeMatchTime(val) {
  if (!isHost) return;
  const msg={type:'update-match-time',matchTime:val};
  processHostMessage(msg,myId);
}
function changeMaxPlayers(val) {
  if (!isHost) return;
  const msg={type:'update-max-players',maxPlayers:val};
  processHostMessage(msg,myId);
}
function changeAiGoalkeepers(val) {
  if (!isHost) return;
  const msg={type:'update-ai-goalkeepers',aiGoalkeepers:val};
  processHostMessage(msg,myId);
}
function changeBallSpeed(val) {
  if (!isHost) return;
  const msg={type:'update-ball-speed',ballSpeed:val};
  processHostMessage(msg,myId);
}
function joinSlot(slot) {
  const msg={type:'select-slot',slot};
  if (isHost) processHostMessage(msg,myId); else sendToHost(msg);
}
function sendStartMatch() {
  if (!isHost) return;
  processHostMessage({type:'start-match'},myId);
}
function addAiToSlot(slotId) {
  const msg={type:'add-ai-slot-player',slot:slotId};
  if (isHost) processHostMessage(msg,myId); else sendToHost(msg);
}
function removeAiFromSlot(slotId) {
  const msg={type:'remove-ai-slot-player',slot:slotId};
  if (isHost) processHostMessage(msg,myId); else sendToHost(msg);
}
function backToLobbyRoom() {
  document.getElementById('gameOverPanel').classList.add('hidden');
  document.getElementById('waitingRoom').classList.remove('hidden');
  gameActive=false;
}

// ─── Mouse / Touch Input ──────────────────────────────────────────────────────
function getPitchScaleFactors() {
  const scale=Math.min(canvas.width/PITCH_WIDTH, canvas.height/PITCH_HEIGHT);
  const offsetX=(canvas.width-PITCH_WIDTH*scale)/2;
  const offsetY=(canvas.height-PITCH_HEIGHT*scale)/2;
  return {scale,offsetX,offsetY};
}

function handleMouseMove(e) {
  if (!gameActive || mySlot==='unassigned') return;
  const rect=canvas.getBoundingClientRect();
  const clientX=e.touches?e.touches[0].clientX:e.clientX;
  const clientY=e.touches?e.touches[0].clientY:e.clientY;
  const canvasX=((clientX-rect.left)/rect.width)*canvas.width;
  const canvasY=((clientY-rect.top)/rect.height)*canvas.height;
  const {scale,offsetX,offsetY}=getPitchScaleFactors();
  let x=(canvasX-offsetX)/scale, y=(canvasY-offsetY)/scale;
  x=Math.max(BOUNDS.xMin,Math.min(BOUNDS.xMax,x));
  y=Math.max(BOUNDS.yMin,Math.min(BOUNDS.yMax,y));
  if (mySlot==='teamA_gk') x=Math.max(BOUNDS.xMin,Math.min(400,x));
  else if (mySlot==='teamB_gk') x=Math.max(1000,Math.min(BOUNDS.xMax,x));
  const msg={type:'move-disc',x,y};
  if (isHost) processHostMessage(msg,myId); else sendToHost(msg);
}

// ─── UI Helpers ───────────────────────────────────────────────────────────────
function showToast(message) {
  const existing=document.getElementById('customToast'); if(existing)existing.remove();
  const toast=document.createElement('div'); toast.id='customToast';
  Object.assign(toast.style,{position:'fixed',top:'24px',left:'50%',transform:'translateX(-50%) translateY(-20px)',background:'linear-gradient(135deg,#059669 0%,#10b981 100%)',color:'#fff',padding:'12px 24px',borderRadius:'12px',boxShadow:'0 10px 25px rgba(16,185,129,0.3)',fontFamily:"'Outfit',sans-serif",fontWeight:'600',fontSize:'0.95rem',zIndex:'9999',opacity:'0',transition:'all 0.3s cubic-bezier(0.18,0.89,0.32,1.25)',display:'flex',alignItems:'center',gap:'8px'});
  toast.innerHTML=`<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg><span>${message}</span>`;
  document.body.appendChild(toast);
  setTimeout(()=>{toast.style.opacity='1';toast.style.transform='translateX(-50%) translateY(0)';},10);
  setTimeout(()=>{toast.style.opacity='0';toast.style.transform='translateX(-50%) translateY(-20px)';setTimeout(()=>toast.remove(),300);},2500);
}

function copyRoomCode() {
  const codeText=document.getElementById('displayRoomCode').innerText;
  navigator.clipboard.writeText(codeText).then(()=>showToast(`Room code copied: ${codeText}`)).catch(()=>{});
}

function updateTimerUI(seconds) {
  // Show as plain seconds so players can easily read remaining time
  document.getElementById('hudTimer').innerText=`${seconds}s`;
}

function showAnnouncement(text) {
  const el=document.getElementById('announcement');
  el.className='announcement goal-text show'; el.innerText=text;
  if (announcementTimeout) clearTimeout(announcementTimeout);
  announcementTimeout=setTimeout(()=>{el.className='announcement';},2200);
}

function triggerGoalExplosion(x,y,color) {
  for (let i=0;i<40;i++){
    const vx=(Math.random()-0.5)*8+(color==='var(--accent-blue)'?3:-3);
    const vy=(Math.random()-0.5)*8;
    particles.push(new Particle(x,y,color,Math.random()*5+3,vx,vy,Math.random()*40+20));
  }
}

function updatePlayerStatsPanel() {
  const list=document.getElementById('statsList'); list.innerHTML='';
  players.forEach(p=>{
    if (p.slot==='unassigned') return;
    const entry=document.createElement('div'); entry.className='stats-entry';
    const isA=p.slot.startsWith('teamA');
    const color=isA?'var(--accent-blue)':'var(--accent-red)';
    let roleIcon='⚽';
    if(p.slot.includes('gk'))roleIcon='🛡️';
    else if(p.slot.includes('midfielder'))roleIcon='🏃';
    else if(p.slot.includes('defender'))roleIcon='🧱';
    else if(p.slot.includes('forward'))roleIcon='🎯';
    entry.innerHTML=`<div class="stats-player-name"><span class="dot" style="background:${color}"></span><span>${p.name}</span></div><span class="stats-score">${roleIcon}</span>`;
    list.appendChild(entry);
  });
}

function updateWaitingRoomUI(state) {
  const teamA=document.getElementById('listTeamA');
  const teamB=document.getElementById('listTeamB');
  const unassigned=document.getElementById('listUnassigned');
  teamA.innerHTML=''; teamB.innerHTML=''; unassigned.innerHTML='';
  const maxPls=state.maxPlayers;
  const teamASlots=[
    {id:'teamA_gk',label:'GK',badge:'GK',class:'blue',minPlayers:4},
    {id:'teamA_striker',label:'Striker',badge:'ST',class:'blue'},
    {id:'teamA_midfielder',label:'Midfielder',badge:'MID',class:'blue',minPlayers:6},
    {id:'teamA_defender',label:'Defender',badge:'DEF',class:'blue',minPlayers:8},
    {id:'teamA_forward',label:'Forward',badge:'FWD',class:'blue',minPlayers:8,aiGkOnly:true}
  ];
  const teamBSlots=[
    {id:'teamB_gk',label:'GK',badge:'GK',class:'red',minPlayers:4},
    {id:'teamB_striker',label:'Striker',badge:'ST',class:'red'},
    {id:'teamB_midfielder',label:'Midfielder',badge:'MID',class:'red',minPlayers:6},
    {id:'teamB_defender',label:'Defender',badge:'DEF',class:'red',minPlayers:8},
    {id:'teamB_forward',label:'Forward',badge:'FWD',class:'red',minPlayers:8,aiGkOnly:true}
  ];
  let countA=0, countB=0, countUn=0;

  function buildSlot(slot, container, teamClass) {
    if (slot.aiGkOnly && !state.aiGoalkeepers) return;
    const isEnabled=!slot.minPlayers||maxPls>=slot.minPlayers;
    const playerInSlot=state.players.find(p=>p.slot===slot.id);
    const isAiGkSlot=state.aiGoalkeepers&&(slot.id==='teamA_gk'||slot.id==='teamB_gk');
    const row=document.createElement('div');
    row.className=`lobby-slot-row ${isEnabled?'':'disabled'} ${isAiGkSlot?'ai-gk-row':''}`;
    if (isAiGkSlot) {
      row.innerHTML=`<span class="slot-role-badge ${slot.class}">${slot.badge}</span><span class="slot-player-name" style="color:var(--primary-hover);font-weight:800">🤖 AI Goalkeeper</span><span class="flag-badge">🤖</span>`;
      if (container===teamA) countA++; else countB++;
    } else if (!isEnabled) {
      row.innerHTML=`<span class="slot-role-badge">${slot.badge}</span><span class="slot-player-name" style="color:var(--text-muted)">🔒 locked</span>`;
    } else if (playerInSlot) {
      const isMe=playerInSlot.id===myId;
      if (playerInSlot.isSlotAI) {
        row.innerHTML=`<span class="slot-role-badge ${slot.class}">${slot.badge}</span><span class="slot-player-name" style="color:#f59e0b;font-weight:800">${playerInSlot.name}</span>${isHost?`<button class="slot-action-btn btn-secondary" onclick="removeAiFromSlot('${slot.id}')">✕ AI</button>`:'<span class="flag-badge">🤖</span>'}`;
      } else if (isMe) {
        const flagOptions=[{code:'BAN',name:'🇧🇩 BAN'},{code:'ARG',name:'🇦🇷 ARG'},{code:'BRA',name:'🇧🇷 BRA'},{code:'GER',name:'🇩🇪 GER'},{code:'FRA',name:'🇫🇷 FRA'},{code:'POR',name:'🇵🇹 POR'},{code:'ESP',name:'🇪🇸 ESP'},{code:'ITA',name:'🇮🇹 ITA'}];
        let sel=`<select class="flag-select" onchange="changeFlag(this.value)">`;
        flagOptions.forEach(f=>{ sel+=`<option value="${f.code}"${playerInSlot.flag===f.code?' selected':''}>${f.name}</option>`; });
        sel+=`</select>`;
        row.innerHTML=`<span class="slot-role-badge ${slot.class}">${slot.badge}</span><span class="slot-player-name" style="font-weight:800">${playerInSlot.name} (you)</span>${sel}<button class="slot-action-btn btn-secondary" onclick="joinSlot('unassigned')">Leave</button>`;
      } else {
        const emoji=flagEmojis[playerInSlot.flag]||'⚽';
        row.innerHTML=`<span class="slot-role-badge ${slot.class}">${slot.badge}</span><span class="slot-player-name">${playerInSlot.name}</span><span class="flag-badge" title="${playerInSlot.flag}">${emoji}</span>`;
      }
      if (container===teamA) countA++; else countB++;
    } else {
      const colorClass=teamClass==='a'?'team-a-bg':'team-b-bg';
      row.innerHTML=`<span class="slot-role-badge">${slot.badge}</span><span class="slot-player-name" style="color:var(--text-muted);font-style:italic">empty</span><button class="slot-action-btn ${colorClass}" onclick="joinSlot('${slot.id}')">Join</button>${isHost?`<button class="slot-action-btn ai-add-btn" onclick="addAiToSlot('${slot.id}')">🤖 AI</button>`:''}`;
    }
    container.appendChild(row);
  }

  teamASlots.forEach(s=>buildSlot(s,teamA,'a'));
  teamBSlots.forEach(s=>buildSlot(s,teamB,'b'));

  state.players.forEach(p=>{
    if (p.slot==='unassigned'){
      const isMe=p.id===myId;
      const entry=document.createElement('div'); entry.className='user-entry';
      entry.innerHTML=`<span class="dot" style="background:${isMe?'#f59e0b':'#9ca3af'}"></span><span style="font-weight:${isMe?'800':'normal'}">${p.name} ${isMe?'(you)':''}</span>${p.isHost?'<span class="badge-host">host</span>':''}`;
      unassigned.appendChild(entry); countUn++;
    }
  });

  document.getElementById('countTeamA').innerText=countA;
  document.getElementById('countTeamB').innerText=countB;
  document.getElementById('countUnassigned').innerText=countUn;
  if (countUn===0) unassigned.innerHTML='<span class="empty-placeholder">empty</span>';
}

// ─── Canvas Rendering ─────────────────────────────────────────────────────────
function drawPitch() {
  ctx.fillStyle='#0f763e'; ctx.fillRect(0,0,PITCH_WIDTH,PITCH_HEIGHT);
  ctx.fillStyle='#0d6b38';
  const sw=PITCH_WIDTH/15;
  for (let i=0;i<15;i+=2) ctx.fillRect(i*sw,0,sw,PITCH_HEIGHT);
  // Outer boundary
  ctx.strokeStyle='rgba(255,255,255,0.9)'; ctx.lineWidth=4;
  ctx.strokeRect(BOUNDS.xMin,BOUNDS.yMin,BOUNDS.xMax-BOUNDS.xMin,BOUNDS.yMax-BOUNDS.yMin);
  // Centre circle
  ctx.beginPath(); ctx.arc(PITCH_WIDTH/2,PITCH_HEIGHT/2,80,0,Math.PI*2);
  ctx.strokeStyle='rgba(255,255,255,0.7)'; ctx.lineWidth=3; ctx.stroke();
  ctx.beginPath(); ctx.arc(PITCH_WIDTH/2,PITCH_HEIGHT/2,5,0,Math.PI*2);
  ctx.fillStyle='rgba(255,255,255,0.7)'; ctx.fill();
  // Centre line
  ctx.beginPath(); ctx.moveTo(PITCH_WIDTH/2,BOUNDS.yMin); ctx.lineTo(PITCH_WIDTH/2,BOUNDS.yMax);
  ctx.strokeStyle='rgba(255,255,255,0.6)'; ctx.lineWidth=3; ctx.stroke();
  // Goal areas
  const goalW=80, goalH=GOAL_BOUNDS.yMax-GOAL_BOUNDS.yMin;
  ctx.strokeStyle='rgba(255,255,255,0.55)'; ctx.lineWidth=2;
  ctx.strokeRect(BOUNDS.xMin,GOAL_BOUNDS.yMin,goalW,goalH);
  ctx.strokeRect(BOUNDS.xMax-goalW,GOAL_BOUNDS.yMin,goalW,goalH);
  // Penalty arcs
  ctx.beginPath(); ctx.arc(BOUNDS.xMin+120,PITCH_HEIGHT/2,70,Math.PI*0.4,Math.PI*1.6,true);
  ctx.strokeStyle='rgba(255,255,255,0.4)'; ctx.stroke();
  ctx.beginPath(); ctx.arc(BOUNDS.xMax-120,PITCH_HEIGHT/2,70,Math.PI*1.6,Math.PI*0.4,true);
  ctx.stroke();
  // Corner arcs
  [[BOUNDS.xMin,BOUNDS.yMin,0,Math.PI*0.5],[BOUNDS.xMax,BOUNDS.yMin,Math.PI*0.5,Math.PI],[BOUNDS.xMax,BOUNDS.yMax,Math.PI,Math.PI*1.5],[BOUNDS.xMin,BOUNDS.yMax,Math.PI*1.5,Math.PI*2]].forEach(([cx,cy,sa,ea])=>{
    ctx.beginPath(); ctx.arc(cx,cy,20,sa,ea); ctx.strokeStyle='rgba(255,255,255,0.5)'; ctx.lineWidth=2; ctx.stroke();
  });
}

function drawGoalNets() {
  const netH=GOAL_BOUNDS.yMax-GOAL_BOUNDS.yMin;
  const netDepth=58, netSegs=12;
  const segH=netH/netSegs;

  function drawNet(xBase, dir) {
    const deforms=(dir>0?netDeformationL:netDeformationR);
    ctx.strokeStyle='rgba(255,255,255,0.25)'; ctx.lineWidth=1.5;
    // Horizontal strands
    for (let i=0;i<=netSegs;i++){
      const y=GOAL_BOUNDS.yMin+i*segH;
      const def=deforms[Math.min(i,netSegs-1)];
      ctx.beginPath();
      ctx.moveTo(xBase,y);
      ctx.quadraticCurveTo(xBase+dir*(netDepth*0.5+Math.abs(def)*0.5),y+def*0.5,xBase+dir*netDepth,y+def);
      ctx.stroke();
    }
    // Vertical strands
    for (let j=0;j<=4;j++){
      const rx=xBase+dir*(j/4)*netDepth;
      ctx.beginPath();
      ctx.moveTo(rx,GOAL_BOUNDS.yMin);
      for (let i=0;i<netSegs;i++){
        const y=GOAL_BOUNDS.yMin+i*segH;
        const def=deforms[i]*((j/4));
        ctx.lineTo(rx+dir*def*0.2,y+segH);
      }
      ctx.stroke();
    }
    // Goal post
    ctx.strokeStyle='rgba(255,255,255,0.9)'; ctx.lineWidth=6;
    ctx.beginPath(); ctx.moveTo(xBase,GOAL_BOUNDS.yMin); ctx.lineTo(xBase,GOAL_BOUNDS.yMax); ctx.stroke();
    ctx.strokeStyle='rgba(255,255,255,0.6)'; ctx.lineWidth=3;
    ctx.beginPath(); ctx.moveTo(xBase,GOAL_BOUNDS.yMin); ctx.lineTo(xBase+dir*netDepth,GOAL_BOUNDS.yMin); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(xBase,GOAL_BOUNDS.yMax); ctx.lineTo(xBase+dir*netDepth,GOAL_BOUNDS.yMax); ctx.stroke();
  }

  drawNet(BOUNDS.xMin,1);
  drawNet(BOUNDS.xMax,-1);
}

function drawBall() {
  // Trail
  ballTrail.forEach((pt,i)=>{
    const alpha=(i/ballTrail.length)*0.25;
    ctx.beginPath(); ctx.arc(pt.x,pt.y,ball.radius*(0.5+i/ballTrail.length*0.5),0,Math.PI*2);
    ctx.fillStyle=`rgba(255,255,255,${alpha})`; ctx.fill();
  });
  // Shadow
  ctx.beginPath(); ctx.ellipse(ball.x+3,ball.y+4,ball.radius*0.85,ball.radius*0.5,0,0,Math.PI*2);
  ctx.fillStyle='rgba(0,0,0,0.25)'; ctx.fill();
  // Base sphere
  const grad=ctx.createRadialGradient(ball.x-ball.radius*0.3,ball.y-ball.radius*0.3,1,ball.x,ball.y,ball.radius);
  grad.addColorStop(0,'#ffffff'); grad.addColorStop(0.3,'#d0d0d0'); grad.addColorStop(0.7,'#888'); grad.addColorStop(1,'#333');
  ctx.beginPath(); ctx.arc(ball.x,ball.y,ball.radius,0,Math.PI*2);
  ctx.fillStyle=grad; ctx.fill();
  // Pentagons
  ctx.strokeStyle='rgba(0,0,0,0.6)'; ctx.lineWidth=1.5;
  const angles=[0,Math.PI*0.4,Math.PI*0.8,Math.PI*1.2,Math.PI*1.6];
  angles.forEach(a=>{
    const bx=ball.x+Math.cos(a)*ball.radius*0.45;
    const by=ball.y+Math.sin(a)*ball.radius*0.45;
    ctx.fillStyle='rgba(0,0,0,0.55)';
    ctx.beginPath();
    for(let k=0;k<5;k++){
      const pa=a+(k/5)*Math.PI*2;
      const px=bx+Math.cos(pa)*ball.radius*0.28;
      const py=by+Math.sin(pa)*ball.radius*0.28;
      k===0?ctx.moveTo(px,py):ctx.lineTo(px,py);
    }
    ctx.closePath(); ctx.fill(); ctx.stroke();
  });
  // Specular
  ctx.beginPath(); ctx.arc(ball.x-ball.radius*0.28,ball.y-ball.radius*0.28,ball.radius*0.22,0,Math.PI*2);
  ctx.fillStyle='rgba(255,255,255,0.55)'; ctx.fill();
}

function drawPlayers() {
  players.forEach(p=>{
    if (p.slot==='unassigned') return;
    const isMe=p.id===myId;
    const isA=p.slot.startsWith('teamA');
    const color=isA?'#00d2ff':'#ff4d4d';
    const radius=p.radius||30;
    ctx.save();
    // Glow for local player
    if (isMe) { ctx.shadowColor=isA?'rgba(0,210,255,0.7)':'rgba(255,77,77,0.7)'; ctx.shadowBlur=18; }
    // Shadow
    ctx.beginPath(); ctx.ellipse(p.x+4,p.y+5,radius*0.9,radius*0.55,0,0,Math.PI*2);
    ctx.fillStyle='rgba(0,0,0,0.25)'; ctx.fill();
    ctx.shadowBlur=0;
    // Jersey
    ctx.beginPath(); ctx.arc(p.x,p.y,radius,0,Math.PI*2);
    const flag=p.flag||'BAN';
    // Country jersey colours
    if (flag==='ARG') {
      const ag=ctx.createLinearGradient(p.x-radius,p.y,p.x+radius,p.y);
      ag.addColorStop(0,'#74c0e8'); ag.addColorStop(0.35,'#74c0e8'); ag.addColorStop(0.35,'#fff'); ag.addColorStop(0.65,'#fff'); ag.addColorStop(0.65,'#74c0e8'); ag.addColorStop(1,'#74c0e8');
      ctx.fillStyle=ag;
    } else if (flag==='BRA') {
      ctx.fillStyle='#009c3b';
      ctx.fill(); ctx.beginPath(); ctx.arc(p.x,p.y,radius*0.65,0,Math.PI*2);
      ctx.fillStyle='#fedf00'; ctx.fill();
      ctx.beginPath(); ctx.arc(p.x,p.y,radius*0.45,0,Math.PI*2);
      ctx.fillStyle='#002776'; ctx.fill(); ctx.restore(); ctx.save();
      ctx.fillStyle='#fff'; ctx.font=`800 ${radius*0.35}px Outfit,sans-serif`;
      ctx.textAlign='center'; ctx.textBaseline='middle'; ctx.fillText('BR',p.x,p.y);
    } else if (flag==='GER') {
      const gg=ctx.createLinearGradient(p.x,p.y-radius,p.x,p.y+radius);
      gg.addColorStop(0,'#000'); gg.addColorStop(0.33,'#000'); gg.addColorStop(0.33,'#dd0000'); gg.addColorStop(0.66,'#dd0000'); gg.addColorStop(0.66,'#ffce00'); gg.addColorStop(1,'#ffce00');
      ctx.fillStyle=gg;
    } else if (flag==='FRA') {
      const fg=ctx.createLinearGradient(p.x-radius,p.y,p.x+radius,p.y);
      fg.addColorStop(0,'#002395'); fg.addColorStop(0.33,'#002395'); fg.addColorStop(0.33,'#fff'); fg.addColorStop(0.66,'#fff'); fg.addColorStop(0.66,'#ed2939'); fg.addColorStop(1,'#ed2939');
      ctx.fillStyle=fg;
    } else if (flag==='POR') {
      const pg=ctx.createLinearGradient(p.x-radius,p.y,p.x+radius,p.y);
      pg.addColorStop(0,'#006600'); pg.addColorStop(0.35,'#006600'); pg.addColorStop(0.35,'#ff0000'); pg.addColorStop(1,'#ff0000');
      ctx.fillStyle=pg;
    } else if (flag==='ESP') {
      const eg=ctx.createLinearGradient(p.x,p.y-radius,p.x,p.y+radius);
      eg.addColorStop(0,'#c60b1e'); eg.addColorStop(0.25,'#c60b1e'); eg.addColorStop(0.25,'#ffc400'); eg.addColorStop(0.75,'#ffc400'); eg.addColorStop(0.75,'#c60b1e'); eg.addColorStop(1,'#c60b1e');
      ctx.fillStyle=eg;
    } else if (flag==='ITA') {
      ctx.fillStyle='#002f6c';
    } else {
      // BAN default
      ctx.fillStyle='#006a4e';
    }
    ctx.fill();
    // Outline
    ctx.strokeStyle=isMe?'#f59e0b':color; ctx.lineWidth=isMe?3:2; ctx.stroke();
    // Jersey number
    let number='10';
    if(p.slot.includes('gk'))number='1';
    else if(p.slot.includes('midfielder'))number='8';
    else if(p.slot.includes('defender'))number='4';
    else if(p.slot.includes('forward'))number='9';
    ctx.fillStyle='rgba(255,255,255,0.88)'; ctx.beginPath(); ctx.arc(p.x,p.y,8,0,Math.PI*2); ctx.fill();
    ctx.fillStyle='#000'; ctx.font='800 0.85rem Outfit,sans-serif'; ctx.textAlign='center'; ctx.textBaseline='middle';
    ctx.fillText(number,p.x,p.y);
    // Velocity arrow
    const vel=Math.hypot(p.vx||0,p.vy||0);
    if (vel>0.6) {
      const angle=Math.atan2(p.vy,p.vx);
      ctx.save(); ctx.translate(p.x,p.y); ctx.rotate(angle);
      ctx.fillStyle=isMe?'#f59e0b':color;
      ctx.beginPath(); ctx.moveTo(radius+4,0); ctx.lineTo(radius-2,-5); ctx.lineTo(radius-2,5); ctx.closePath(); ctx.fill();
      ctx.restore();
    }
    // Name tag
    ctx.fillStyle='#fff'; ctx.font='600 0.85rem Outfit,sans-serif'; ctx.textAlign='center';
    ctx.shadowColor='rgba(0,0,0,0.85)'; ctx.shadowBlur=4;
    let roleTag=' [ST]';
    if(p.slot.includes('gk'))roleTag=' [GK]';
    else if(p.slot.includes('midfielder'))roleTag=' [MID]';
    else if(p.slot.includes('defender'))roleTag=' [DEF]';
    else if(p.slot.includes('forward'))roleTag=' [FWD]';
    ctx.fillText(p.name+roleTag,p.x,p.y-radius-8);
    ctx.restore();
  });
}

function gameLoop() {
  particles.forEach((p,idx)=>{ p.update(); if(p.life<=0) particles.splice(idx,1); });
  if (gameActive) {
    ctx.clearRect(0,0,canvas.width,canvas.height);
    const {scale,offsetX,offsetY}=getPitchScaleFactors();
    ctx.save(); ctx.translate(offsetX,offsetY); ctx.scale(scale,scale);
    drawPitch(); drawGoalNets(); drawBall(); drawPlayers();
    particles.forEach(p=>p.draw(ctx));
    ctx.restore();
  }
  requestAnimationFrame(gameLoop);
}

// ─── Sound Toggle ─────────────────────────────────────────────────────────────
document.getElementById('soundToggle').addEventListener('click',()=>{
  const isMuted=sound.toggleMute();
  document.getElementById('soundIcon').innerText=isMuted?'🔇':'🔊';
});

// ─── Canvas Resize ────────────────────────────────────────────────────────────
function resizeCanvas() {
  const container=document.getElementById('gameContainer');
  canvas.width=container.clientWidth; canvas.height=container.clientHeight;
}
window.addEventListener('resize',resizeCanvas);

// ─── Init ─────────────────────────────────────────────────────────────────────
window.addEventListener('DOMContentLoaded',()=>{
  resizeCanvas();
  window.addEventListener('mousemove',handleMouseMove);
  window.addEventListener('touchmove',handleMouseMove,{passive:true});
  gameLoop();
});
