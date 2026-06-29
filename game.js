// Upgraded 2D Cursor Soccer Game Client Logic
// Features dynamic slot layouts, coordinate scaling, detailed jerseys, 3D ball, and textured pitch

// Audio Synthesizer
class SoundSynth {
  constructor() {
    this.ctx = null;
    this.muted = false;
  }

  init() {
    if (this.ctx) return;
    try {
      this.ctx = new (window.AudioContext || window.webkitAudioContext)();
    } catch (e) {
      console.warn("Web Audio API not supported", e);
    }
  }

  toggleMute() {
    this.muted = !this.muted;
    return this.muted;
  }

  playKick() {
    if (this.muted || !this.ctx) return;
    this.init();
    const now = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();
    
    osc.type = 'triangle';
    osc.frequency.setValueAtTime(180, now);
    osc.frequency.exponentialRampToValueAtTime(10, now + 0.12);
    
    gain.gain.setValueAtTime(0.8, now);
    gain.gain.exponentialRampToValueAtTime(0.01, now + 0.12);
    
    osc.connect(gain);
    gain.connect(this.ctx.destination);
    
    osc.start(now);
    osc.stop(now + 0.12);
  }

  playGoal() {
    if (this.muted || !this.ctx) return;
    this.init();
    const now = this.ctx.currentTime;
    
    this.playWhistle(0.6);
    
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
    
    noise.connect(filter);
    filter.connect(gain);
    gain.connect(this.ctx.destination);
    
    noise.start(now);
  }

  playWhistle(duration = 0.35) {
    if (this.muted || !this.ctx) return;
    this.init();
    const now = this.ctx.currentTime;
    const osc1 = this.ctx.createOscillator();
    const osc2 = this.ctx.createOscillator();
    const gain = this.ctx.createGain();
    
    osc1.type = 'sine';
    osc1.frequency.setValueAtTime(1300, now);
    osc1.frequency.linearRampToValueAtTime(1350, now + duration * 0.2);
    osc1.frequency.linearRampToValueAtTime(1300, now + duration * 0.8);
    
    osc2.type = 'triangle';
    osc2.frequency.setValueAtTime(1304, now);
    
    gain.gain.setValueAtTime(0.01, now);
    gain.gain.linearRampToValueAtTime(0.15, now + 0.05);
    gain.gain.exponentialRampToValueAtTime(0.01, now + duration);
    
    osc1.connect(gain);
    osc2.connect(gain);
    gain.connect(this.ctx.destination);
    
    osc1.start(now);
    osc2.start(now);
    osc1.stop(now + duration + 0.05);
    osc2.stop(now + duration + 0.05);
  }
}

// Particle System for Kick and Goal splashes
class Particle {
  constructor(x, y, color, size, vx, vy, life) {
    this.x = x;
    this.y = y;
    this.color = color;
    this.size = size;
    this.vx = vx;
    this.vy = vy;
    this.life = life;
    this.maxLife = life;
  }
  update() {
    this.x += this.vx;
    this.y += this.vy;
    this.vx *= 0.96;
    this.vy *= 0.96;
    this.life--;
  }
  draw(ctx) {
    ctx.save();
    ctx.globalAlpha = this.life / this.maxLife;
    ctx.fillStyle = this.color;
    ctx.beginPath();
    ctx.arc(this.x, this.y, this.size, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }
}

// Global variables
const canvas = document.getElementById('gameCanvas');
const ctx = canvas.getContext('2d');
const sound = new SoundSynth();

// Dynamic detection of server deployment: connects to local server OR deployed socket instance
const socket = io(window.location.origin);

const flagEmojis = {
  BAN: '🇧🇩', ARG: '🇦🇷', BRA: '🇧🇷', GER: '🇩🇪',
  FRA: '🇫🇷', POR: '🇵🇹', ESP: '🇪🇸', ITA: '🇮🇹'
};

function changeFlag(flag) {
  socket.emit('select-flag', { roomCode, flag });
}

// Larger 2D Pitch Dimensions matching implementation plan
const PITCH_WIDTH = 1400;
const PITCH_HEIGHT = 850;
const BOUNDS = {
  xMin: 80,
  xMax: 1320,
  yMin: 60,
  yMax: 790
};
const GOAL_BOUNDS = {
  yMin: 320,
  yMax: 530
};

let myId = '';
let playerName = '';
let roomCode = '';
let mySlot = 'unassigned';
let isHost = false;
let gameActive = false;
let announcementTimeout = null;

// Synced parameters
let ball = { x: 700, y: 425, vx: 0, vy: 0, radius: 18 };
let players = [];
let scores = { A: 0, B: 0 };
let timeRemaining = 60;
let maxPlayers = 2;
let particles = [];
let ballTrail = [];

// Net ripples mesh grids
let netDeformationL = Array(12).fill(0);
let netDeformationR = Array(12).fill(0);

// --- Screen Navigation & Inputs ---

function showLobbySelect() {
  const name = document.getElementById('playerNameInput').value.trim();
  if (!name) {
    alert("Please enter a username.");
    return;
  }
  playerName = name;
  document.getElementById('loginMenu').classList.add('hidden');
  document.getElementById('lobbyMenu').classList.remove('hidden');
  sound.init();
}

function backToLogin() {
  document.getElementById('lobbyMenu').classList.add('hidden');
  document.getElementById('loginMenu').classList.remove('hidden');
}

function createRoom() {
  socket.emit('create-room', { playerName });
}

function joinRoom() {
  const code = document.getElementById('roomCodeInput').value.trim().toUpperCase();
  if (code.length !== 6) {
    document.getElementById('lobbyError').innerText = "Enter a valid 6-letter room code.";
    return;
  }
  socket.emit('join-room', { roomCode: code, playerName });
}

function showToast(message) {
  const existing = document.getElementById('customToast');
  if (existing) {
    existing.remove();
  }
  
  const toast = document.createElement('div');
  toast.id = 'customToast';
  toast.style.position = 'fixed';
  toast.style.top = '24px';
  toast.style.left = '50%';
  toast.style.transform = 'translateX(-50%) translateY(-20px)';
  toast.style.background = 'linear-gradient(135deg, #059669 0%, #10b981 100%)';
  toast.style.color = '#fff';
  toast.style.padding = '12px 24px';
  toast.style.borderRadius = '12px';
  toast.style.boxShadow = '0 10px 25px rgba(16, 185, 129, 0.3)';
  toast.style.fontFamily = "'Outfit', sans-serif";
  toast.style.fontWeight = '600';
  toast.style.fontSize = '0.95rem';
  toast.style.zIndex = '9999';
  toast.style.opacity = '0';
  toast.style.transition = 'all 0.3s cubic-bezier(0.18, 0.89, 0.32, 1.25)';
  toast.style.display = 'flex';
  toast.style.alignItems = 'center';
  toast.style.gap = '8px';
  
  toast.innerHTML = `
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
      <polyline points="20 6 9 17 4 12"></polyline>
    </svg>
    <span>${message}</span>
  `;
  
  document.body.appendChild(toast);
  
  setTimeout(() => {
    toast.style.opacity = '1';
    toast.style.transform = 'translateX(-50%) translateY(0)';
  }, 10);
  
  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transform = 'translateX(-50%) translateY(-20px)';
    setTimeout(() => {
      toast.remove();
    }, 300);
  }, 2500);
}

function copyRoomCode() {
  const codeText = document.getElementById('displayRoomCode').innerText;
  navigator.clipboard.writeText(codeText).then(() => {
    showToast(`Room code copied: ${codeText}`);
  }).catch(err => {
    console.error('Could not copy text: ', err);
  });
}

function changeMatchTime(val) {
  if (isHost) {
    socket.emit('update-match-time', { roomCode, matchTime: val });
  }
}

function changeMaxPlayers(val) {
  if (isHost) {
    socket.emit('update-max-players', { roomCode, maxPlayers: val });
  }
}

function changeAiGoalkeepers(val) {
  if (isHost) {
    socket.emit('update-ai-goalkeepers', { roomCode, aiGoalkeepers: val });
  }
}

function changeBallSpeed(val) {
  if (isHost) {
    socket.emit('update-ball-speed', { roomCode, ballSpeed: val });
  }
}

function joinSlot(slot) {
  socket.emit('select-slot', { roomCode, slot });
}

function sendStartMatch() {
  if (isHost) {
    socket.emit('start-match', { roomCode });
  }
}

function backToLobbyRoom() {
  document.getElementById('gameOverPanel').classList.add('hidden');
  document.getElementById('waitingRoom').classList.remove('hidden');
  gameActive = false;
}

// --- Socket Event Listeners ---

socket.on('room-created', ({ roomCode: code, roomState, myId: id }) => {
  roomCode = code;
  myId = id;
  isHost = true;
  maxPlayers = roomState.maxPlayers;
  
  document.getElementById('displayRoomCode').innerText = roomCode;
  document.getElementById('matchTimeSelect').disabled = false;
  document.getElementById('maxPlayersSelect').disabled = false;
  document.getElementById('aiGoalkeepersSelect').disabled = false;
  document.getElementById('ballSpeedSelect').disabled = false;
  document.getElementById('startMatchBtn').style.display = 'block';
  
  updateWaitingRoomUI(roomState);
  
  document.getElementById('lobbyMenu').classList.add('hidden');
  document.getElementById('waitingRoom').classList.remove('hidden');
});

socket.on('room-joined', ({ roomCode: code, roomState, myId: id }) => {
  roomCode = code;
  myId = id;
  isHost = false;
  maxPlayers = roomState.maxPlayers;
  
  document.getElementById('displayRoomCode').innerText = roomCode;
  document.getElementById('matchTimeSelect').disabled = true;
  document.getElementById('maxPlayersSelect').disabled = true;
  document.getElementById('aiGoalkeepersSelect').disabled = true;
  document.getElementById('ballSpeedSelect').disabled = true;
  document.getElementById('startMatchBtn').style.display = 'none';
  
  updateWaitingRoomUI(roomState);
  
  document.getElementById('lobbyMenu').classList.add('hidden');
  document.getElementById('waitingRoom').classList.remove('hidden');
});

socket.on('room-state-updated', ({ roomState }) => {
  maxPlayers = roomState.maxPlayers;
  
  const me = roomState.players.find(p => p.id === socket.id);
  if (me) {
    isHost = me.isHost;
    mySlot = me.slot;
  }
  
  const hasTeamA = roomState.players.some(p => p.slot.startsWith('teamA'));
  const hasTeamB = roomState.players.some(p => p.slot.startsWith('teamB'));
  
  const startBtn = document.getElementById('startMatchBtn');
  if (isHost) {
    startBtn.style.display = 'block';
    startBtn.disabled = !(hasTeamA && hasTeamB);
    document.getElementById('matchTimeSelect').disabled = false;
    document.getElementById('maxPlayersSelect').disabled = false;
    document.getElementById('aiGoalkeepersSelect').disabled = false;
    document.getElementById('ballSpeedSelect').disabled = false;
  } else {
    startBtn.style.display = 'none';
    document.getElementById('matchTimeSelect').disabled = true;
    document.getElementById('maxPlayersSelect').disabled = true;
    document.getElementById('aiGoalkeepersSelect').disabled = true;
    document.getElementById('ballSpeedSelect').disabled = true;
  }

  document.getElementById('matchTimeSelect').value = roomState.matchTime.toString();
  document.getElementById('maxPlayersSelect').value = roomState.maxPlayers.toString();
  document.getElementById('aiGoalkeepersSelect').value = roomState.aiGoalkeepers.toString();
  document.getElementById('ballSpeedSelect').value = roomState.ballSpeedLimit.toString();
  
  updateWaitingRoomUI(roomState);
});

socket.on('slot-error', ({ message }) => {
  alert(message);
});

socket.on('match-started', ({ roomState }) => {
  gameActive = true;
  scores = roomState.scores;
  timeRemaining = roomState.matchTime;
  ball = roomState.ball;
  players = roomState.players;
  
  document.getElementById('scoreA').innerText = '0';
  document.getElementById('scoreB').innerText = '0';
  updateTimerUI(timeRemaining);
  
  document.getElementById('waitingRoom').classList.add('hidden');
  document.getElementById('gameOverPanel').classList.add('hidden');
  
  document.getElementById('gameHUD').classList.remove('hidden');
  document.getElementById('playerStatsPanel').classList.remove('hidden');
  canvas.classList.remove('hidden');
  
  particles = [];
  ballTrail = [];
  netDeformationL.fill(0);
  netDeformationR.fill(0);
  
  resizeCanvas();
  sound.playWhistle();
});

socket.on('physics-tick', (data) => {
  if (!gameActive) return;
  
  // Calculate movement trail if ball is fast
  const speed = Math.sqrt(data.ball.vx * data.ball.vx + data.ball.vy * data.ball.vy);
  if (speed > 1.8) {
    ballTrail.push({ x: data.ball.x, y: data.ball.y });
    if (ballTrail.length > 8) ballTrail.shift();
    
    // Spawn dirt particles behind ball
    if (Math.random() < 0.3) {
      particles.push(new Particle(data.ball.x, data.ball.y, 'rgba(255,255,255,0.15)', Math.random()*2+1, -data.ball.vx*0.2, -data.ball.vy*0.2, 15));
    }
  } else {
    ballTrail.shift();
  }

  // Play thud on disc hit
  const oldSpeed = Math.sqrt(ball.vx * ball.vx + ball.vy * ball.vy);
  if (speed > oldSpeed + 1.2) {
    sound.playKick();
  }

  ball = { ...ball, ...data.ball };
  players = data.players;
  scores = data.scores;
  
  document.getElementById('scoreA').innerText = scores.A;
  document.getElementById('scoreB').innerText = scores.B;
  
  // Decelerate goals net deformations
  for (let i = 0; i < 12; i++) {
    netDeformationL[i] *= 0.88;
    netDeformationR[i] *= 0.88;
  }

  updatePlayerStatsPanel();
});

socket.on('goal-scored', ({ scoringTeam, scores: newScores }) => {
  scores = newScores;
  
  // Trigger explosion
  const px = scoringTeam === 'A' ? BOUNDS.xMax + 10 : BOUNDS.xMin - 10;
  const py = PITCH_HEIGHT / 2;
  const color = scoringTeam === 'A' ? 'var(--accent-blue)' : 'var(--accent-red)';
  
  // Ripple the goal nets
  if (scoringTeam === 'A') {
    netDeformationR.fill(16);
  } else {
    netDeformationL.fill(-16);
  }

  triggerGoalExplosion(px, py, color);
  showAnnouncement('GOAL!');
  sound.playGoal();
});

socket.on('timer-updated', ({ timeRemaining: time }) => {
  timeRemaining = time;
  updateTimerUI(timeRemaining);
});

socket.on('game-over', ({ scores: finalScores, players: list }) => {
  gameActive = false;
  canvas.classList.add('hidden');
  document.getElementById('gameHUD').classList.add('hidden');
  document.getElementById('playerStatsPanel').classList.add('hidden');

  // Update score banner
  document.getElementById('finalScoreA').innerText = finalScores.A;
  document.getElementById('finalScoreB').innerText = finalScores.B;

  const verdict = document.getElementById('matchVerdict');
  if (finalScores.A > finalScores.B) {
    verdict.innerText = '🏆 Team A Wins!';
    verdict.style.color = 'var(--accent-blue)';
  } else if (finalScores.B > finalScores.A) {
    verdict.innerText = '🏆 Team B Wins!';
    verdict.style.color = 'var(--accent-red)';
  } else {
    verdict.innerText = "It's a Draw!";
    verdict.style.color = '#fff';
  }

  // Build per-player stats table
  const statsList = document.getElementById('gameoverStatsList');
  statsList.innerHTML = '';

  const sorted = [...list].sort((a, b) => {
    const tA = a.slot.startsWith('teamA') ? 0 : 1;
    const tB = b.slot.startsWith('teamA') ? 0 : 1;
    if (tA !== tB) return tA - tB;
    return (b.stats?.goals || 0) - (a.stats?.goals || 0);
  });

  sorted.forEach(p => {
    const isTeamA = p.slot.startsWith('teamA');
    const teamColor = isTeamA ? 'var(--accent-blue)' : 'var(--accent-red)';
    const teamLabel = isTeamA ? 'A' : 'B';
    const goals = p.stats?.goals || 0;
    const touches = p.stats?.touches || 0;

    let roleLabel = 'ST';
    if (p.slot.includes('gk')) roleLabel = 'GK';
    else if (p.slot.includes('midfielder')) roleLabel = 'MID';
    else if (p.slot.includes('defender')) roleLabel = 'DEF';
    else if (p.slot.includes('forward')) roleLabel = 'FWD';

    const row = document.createElement('div');
    row.className = `gameover-stat-row ${isTeamA ? 'team-a-row' : 'team-b-row'}`;
    row.innerHTML = `
      <div class="gos-name">
        <span class="gos-team-dot" style="background:${teamColor}"></span>
        <span class="gos-role-badge" style="color:${teamColor}">${roleLabel}</span>
        <span class="gos-player-name">${p.name}${p.isAI ? ' 🤖' : ''}</span>
      </div>
      <div class="gos-team-cell">
        <span class="gos-team-badge" style="color:${teamColor};border-color:${teamColor}">${teamLabel}</span>
      </div>
      <div class="gos-stat-cell">
        <span class="gos-val">${goals}</span>
        <span class="gos-lbl">Goals</span>
      </div>
      <div class="gos-stat-cell">
        <span class="gos-val">${touches}</span>
        <span class="gos-lbl">Touches</span>
      </div>
    `;
    statsList.appendChild(row);
  });

  document.getElementById('gameOverPanel').classList.remove('hidden');
  sound.playWhistle(0.85);
});

// Add AI bot to a specific slot (host only)
function addAiToSlot(slotId) {
  socket.emit('add-ai-slot-player', { roomCode, slot: slotId });
}

// Remove AI bot from a specific slot (host only)
function removeAiFromSlot(slotId) {
  socket.emit('remove-ai-slot-player', { roomCode, slot: slotId });
}

// --- Dynamic Lobby Grid builder based on player count limit ---

function updateWaitingRoomUI(state) {
  const teamA = document.getElementById('listTeamA');
  const teamB = document.getElementById('listTeamB');
  const unassigned = document.getElementById('listUnassigned');
  
  teamA.innerHTML = '';
  teamB.innerHTML = '';
  unassigned.innerHTML = '';
  
  const maxPls = state.maxPlayers;
  
  const teamASlots = [
    { id: 'teamA_gk', label: 'GK', badge: 'GK', class: 'blue', minPlayers: 4 },
    { id: 'teamA_striker', label: 'Striker', badge: 'ST', class: 'blue' },
    { id: 'teamA_midfielder', label: 'Midfielder', badge: 'MID', class: 'blue', minPlayers: 6 },
    { id: 'teamA_defender', label: 'Defender', badge: 'DEF', class: 'blue', minPlayers: 8 },
    { id: 'teamA_forward', label: 'Forward', badge: 'FWD', class: 'blue', minPlayers: 8, aiGkOnly: true }
  ];
  
  const teamBSlots = [
    { id: 'teamB_gk', label: 'GK', badge: 'GK', class: 'red', minPlayers: 4 },
    { id: 'teamB_striker', label: 'Striker', badge: 'ST', class: 'red' },
    { id: 'teamB_midfielder', label: 'Midfielder', badge: 'MID', class: 'red', minPlayers: 6 },
    { id: 'teamB_defender', label: 'Defender', badge: 'DEF', class: 'red', minPlayers: 8 },
    { id: 'teamB_forward', label: 'Forward', badge: 'FWD', class: 'red', minPlayers: 8, aiGkOnly: true }
  ];
  
  let countA = 0;
  let countB = 0;
  let countUn = 0;

  // Build Team A card slots
  teamASlots.forEach(slot => {
    // Forward slot is only available when AI Goalkeepers is enabled
    if (slot.aiGkOnly && !state.aiGoalkeepers) return;
    const isSlotEnabled = !slot.minPlayers || maxPls >= slot.minPlayers;
    const playerInSlot = state.players.find(p => p.slot === slot.id);
    const isAiGkSlot = state.aiGoalkeepers && slot.id === 'teamA_gk';
    
    const row = document.createElement('div');
    row.className = `lobby-slot-row ${isSlotEnabled ? '' : 'disabled'} ${isAiGkSlot ? 'ai-gk-row' : ''}`;
    
    if (isAiGkSlot) {
      row.innerHTML = `
        <span class="slot-role-badge ${slot.class}">${slot.badge}</span>
        <span class="slot-player-name" style="color: var(--primary-hover); font-weight: 800;">🤖 AI Goalkeeper</span>
        <span class="flag-badge">🤖</span>
      `;
      countA++;
    } else if (!isSlotEnabled) {
      row.innerHTML = `
        <span class="slot-role-badge">${slot.badge}</span>
        <span class="slot-player-name" style="color: var(--text-muted);">🔒 locked</span>
      `;
    } else if (playerInSlot) {
      const isMe = playerInSlot.id === socket.id;
      if (playerInSlot.isSlotAI) {
        // AI slot player — show bot name with optional remove button for host
        row.innerHTML = `
          <span class="slot-role-badge ${slot.class}">${slot.badge}</span>
          <span class="slot-player-name" style="color:#f59e0b;font-weight:800;">${playerInSlot.name}</span>
          ${isHost ? `<button class="slot-action-btn btn-secondary" onclick="removeAiFromSlot('${slot.id}')">✕ AI</button>` : '<span class="flag-badge">🤖</span>'}
        `;
      } else if (isMe) {
        let selectHtml = `<select class="flag-select" onchange="changeFlag(this.value)">`;
        const flagOptions = [
          { code: 'BAN', name: '🇧🇩 BAN' },
          { code: 'ARG', name: '🇦🇷 ARG' },
          { code: 'BRA', name: '🇧🇷 BRA' },
          { code: 'GER', name: '🇩🇪 GER' },
          { code: 'FRA', name: '🇫🇷 FRA' },
          { code: 'POR', name: '🇵🇹 POR' },
          { code: 'ESP', name: '🇪🇸 ESP' },
          { code: 'ITA', name: '🇮🇹 ITA' }
        ];
        flagOptions.forEach(f => {
          const selected = playerInSlot.flag === f.code ? 'selected' : '';
          selectHtml += `<option value="${f.code}" ${selected}>${f.name}</option>`;
        });
        selectHtml += `</select>`;
        row.innerHTML = `
          <span class="slot-role-badge ${slot.class}">${slot.badge}</span>
          <span class="slot-player-name" style="font-weight:800">${playerInSlot.name} (you)</span>
          ${selectHtml}
          <button class="slot-action-btn btn-secondary" onclick="joinSlot('unassigned')">Leave</button>
        `;
      } else {
        const emoji = flagEmojis[playerInSlot.flag] || '⚽';
        row.innerHTML = `
          <span class="slot-role-badge ${slot.class}">${slot.badge}</span>
          <span class="slot-player-name">${playerInSlot.name}</span>
          <span class="flag-badge" title="${playerInSlot.flag}">${emoji}</span>
        `;
      }
      countA++;
    } else {
      row.innerHTML = `
        <span class="slot-role-badge">${slot.badge}</span>
        <span class="slot-player-name" style="color:var(--text-muted);font-style:italic;">empty</span>
        <button class="slot-action-btn team-a-bg" onclick="joinSlot('${slot.id}')">Join</button>
        ${isHost ? `<button class="slot-action-btn ai-add-btn" onclick="addAiToSlot('${slot.id}')">🤖 AI</button>` : ''}
      `;
    }
    teamA.appendChild(row);
  });

  // Build Team B card slots
  teamBSlots.forEach(slot => {
    // Forward slot is only available when AI Goalkeepers is enabled
    if (slot.aiGkOnly && !state.aiGoalkeepers) return;
    const isSlotEnabled = !slot.minPlayers || maxPls >= slot.minPlayers;
    const playerInSlot = state.players.find(p => p.slot === slot.id);
    const isAiGkSlot = state.aiGoalkeepers && slot.id === 'teamB_gk';
    
    const row = document.createElement('div');
    row.className = `lobby-slot-row ${isSlotEnabled ? '' : 'disabled'} ${isAiGkSlot ? 'ai-gk-row' : ''}`;
    
    if (isAiGkSlot) {
      row.innerHTML = `
        <span class="slot-role-badge ${slot.class}">${slot.badge}</span>
        <span class="slot-player-name" style="color: var(--primary-hover); font-weight: 800;">🤖 AI Goalkeeper</span>
        <span class="flag-badge">🤖</span>
      `;
      countB++;
    } else if (!isSlotEnabled) {
      row.innerHTML = `
        <span class="slot-role-badge">${slot.badge}</span>
        <span class="slot-player-name" style="color: var(--text-muted);">🔒 locked</span>
      `;
    } else if (playerInSlot) {
      const isMe = playerInSlot.id === socket.id;
      if (playerInSlot.isSlotAI) {
        row.innerHTML = `
          <span class="slot-role-badge ${slot.class}">${slot.badge}</span>
          <span class="slot-player-name" style="color:#f59e0b;font-weight:800;">${playerInSlot.name}</span>
          ${isHost ? `<button class="slot-action-btn btn-secondary" onclick="removeAiFromSlot('${slot.id}')">✕ AI</button>` : '<span class="flag-badge">🤖</span>'}
        `;
      } else if (isMe) {
        let selectHtml = `<select class="flag-select" onchange="changeFlag(this.value)">`;
        const flagOptions = [
          { code: 'BAN', name: '🇧🇩 BAN' },
          { code: 'ARG', name: '🇦🇷 ARG' },
          { code: 'BRA', name: '🇧🇷 BRA' },
          { code: 'GER', name: '🇩🇪 GER' },
          { code: 'FRA', name: '🇫🇷 FRA' },
          { code: 'POR', name: '🇵🇹 POR' },
          { code: 'ESP', name: '🇪🇸 ESP' },
          { code: 'ITA', name: '🇮🇹 ITA' }
        ];
        flagOptions.forEach(f => {
          const selected = playerInSlot.flag === f.code ? 'selected' : '';
          selectHtml += `<option value="${f.code}" ${selected}>${f.name}</option>`;
        });
        selectHtml += `</select>`;
        row.innerHTML = `
          <span class="slot-role-badge ${slot.class}">${slot.badge}</span>
          <span class="slot-player-name" style="font-weight:800">${playerInSlot.name} (you)</span>
          ${selectHtml}
          <button class="slot-action-btn btn-secondary" onclick="joinSlot('unassigned')">Leave</button>
        `;
      } else {
        const emoji = flagEmojis[playerInSlot.flag] || '⚽';
        row.innerHTML = `
          <span class="slot-role-badge ${slot.class}">${slot.badge}</span>
          <span class="slot-player-name">${playerInSlot.name}</span>
          <span class="flag-badge" title="${playerInSlot.flag}">${emoji}</span>
        `;
      }
      countB++;
    } else {
      row.innerHTML = `
        <span class="slot-role-badge">${slot.badge}</span>
        <span class="slot-player-name" style="color:var(--text-muted);font-style:italic;">empty</span>
        <button class="slot-action-btn team-b-bg" onclick="joinSlot('${slot.id}')">Join</button>
        ${isHost ? `<button class="slot-action-btn ai-add-btn" onclick="addAiToSlot('${slot.id}')">🤖 AI</button>` : ''}
      `;
    }
    teamB.appendChild(row);
  });

  // Populate unassigned column
  state.players.forEach(p => {
    if (p.slot === 'unassigned') {
      const isMe = p.id === socket.id;
      const entry = document.createElement('div');
      entry.className = 'user-entry';
      entry.innerHTML = `
        <span class="dot" style="background: ${isMe ? '#f59e0b' : '#9ca3af'}"></span>
        <span style="font-weight: ${isMe ? '800' : 'normal'}">${p.name} ${isMe ? '(you)' : ''}</span>
        ${p.isHost ? '<span class="badge-host">host</span>' : ''}
      `;
      unassigned.appendChild(entry);
      countUn++;
    }
  });

  document.getElementById('countTeamA').innerText = countA;
  document.getElementById('countTeamB').innerText = countB;
  document.getElementById('countUnassigned').innerText = countUn;

  if (countUn === 0) unassigned.innerHTML = '<span class="empty-placeholder">empty</span>';
}

function updateTimerUI(seconds) {
  const min = Math.floor(seconds / 60);
  const sec = seconds % 60;
  const timeStr = `${min}:${sec < 10 ? '0' : ''}${sec}`;
  document.getElementById('hudTimer').innerText = timeStr;
}

function updatePlayerStatsPanel() {
  const list = document.getElementById('statsList');
  list.innerHTML = '';
  
  players.forEach(p => {
    if (p.slot === 'unassigned') return;
    
    const entry = document.createElement('div');
    entry.className = 'stats-entry';
    
    const isTeamA = p.slot.startsWith('teamA');
    const color = isTeamA ? 'var(--accent-blue)' : 'var(--accent-red)';
    
    let roleIcon = '⚽';
    if (p.slot.includes('gk')) roleIcon = '🛡️';
    else if (p.slot.includes('midfielder')) roleIcon = '🏃';
    else if (p.slot.includes('defender')) roleIcon = '🧱';
    else if (p.slot.includes('forward')) roleIcon = '🎯';
    
    entry.innerHTML = `
      <div class="stats-player-name">
        <span class="dot" style="background: ${color}"></span>
        <span>${p.name}</span>
      </div>
      <span class="stats-score">${roleIcon}</span>
    `;
    list.appendChild(entry);
  });
}

function showAnnouncement(text) {
  const el = document.getElementById('announcement');
  el.className = 'announcement goal-text show';
  el.innerText = text;
  
  if (announcementTimeout) clearTimeout(announcementTimeout);
  announcementTimeout = setTimeout(() => {
    el.className = 'announcement';
  }, 2200);
}

function triggerGoalExplosion(x, y, color) {
  for (let i = 0; i < 40; i++) {
    const vx = (Math.random() - 0.5) * 8 + (color === 'var(--accent-blue)' ? 3 : -3);
    const vy = (Math.random() - 0.5) * 8;
    particles.push(new Particle(x, y, color, Math.random() * 5 + 3, vx, vy, Math.random() * 40 + 20));
  }
}

// --- Coordinate translations (Scaling) ---

function getPitchScaleFactors() {
  const scale = Math.min(canvas.width / PITCH_WIDTH, canvas.height / PITCH_HEIGHT);
  const offsetX = (canvas.width - PITCH_WIDTH * scale) / 2;
  const offsetY = (canvas.height - PITCH_HEIGHT * scale) / 2;
  return { scale, offsetX, offsetY };
}

function handleMouseMove(e) {
  if (!gameActive || mySlot === 'unassigned') return;
  
  const rect = canvas.getBoundingClientRect();
  const clientX = e.touches ? e.touches[0].clientX : e.clientX;
  const clientY = e.touches ? e.touches[0].clientY : e.clientY;
  
  const canvasX = ((clientX - rect.left) / rect.width) * canvas.width;
  const canvasY = ((clientY - rect.top) / rect.height) * canvas.height;
  
  const { scale, offsetX, offsetY } = getPitchScaleFactors();
  
  // Translate screen pointer to physics coordinates
  let x = (canvasX - offsetX) / scale;
  let y = (canvasY - offsetY) / scale;
  
  // Boundary constraints
  x = Math.max(BOUNDS.xMin, Math.min(BOUNDS.xMax, x));
  y = Math.max(BOUNDS.yMin, Math.min(BOUNDS.yMax, y));
  
  // Role constraints (Keepers cannot cross their penalty halves)
  if (mySlot === 'teamA_gk') {
    x = Math.max(BOUNDS.xMin, Math.min(400, x));
  } else if (mySlot === 'teamB_gk') {
    x = Math.max(1000, Math.min(BOUNDS.xMax, x));
  }
  
  socket.emit('move-disc', { roomCode, x, y });
}

// --- Canvas 2D Upgraded Rendering ---

function drawPitch() {
  // 1. Alternate grass green mowing stripes
  ctx.fillStyle = '#0f763e';
  ctx.fillRect(0, 0, PITCH_WIDTH, PITCH_HEIGHT);
  
  ctx.fillStyle = '#0d6b38';
  const stripeWidth = PITCH_WIDTH / 15;
  for (let i = 0; i < 15; i += 2) {
    ctx.fillRect(i * stripeWidth, 0, stripeWidth, PITCH_HEIGHT);
  }

  // Dark margins
  ctx.fillStyle = '#09522b';
  ctx.fillRect(0, 0, BOUNDS.xMin, PITCH_HEIGHT);
  ctx.fillRect(BOUNDS.xMax, 0, PITCH_WIDTH - BOUNDS.xMax, PITCH_HEIGHT);

  // White markings lines
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.35)';
  ctx.lineWidth = 4.5;
  
  // Boundary border
  ctx.strokeRect(BOUNDS.xMin, BOUNDS.yMin, BOUNDS.xMax - BOUNDS.xMin, BOUNDS.yMax - BOUNDS.yMin);
  
  // Center line & circle
  ctx.beginPath();
  ctx.moveTo(PITCH_WIDTH / 2, BOUNDS.yMin);
  ctx.lineTo(PITCH_WIDTH / 2, BOUNDS.yMax);
  ctx.stroke();
  
  ctx.beginPath();
  ctx.arc(PITCH_WIDTH / 2, PITCH_HEIGHT / 2, 90, 0, Math.PI * 2);
  ctx.stroke();

  // Penalty box and arcs
  // Team A
  ctx.strokeRect(BOUNDS.xMin, BOUNDS.yMin + 140, 160, BOUNDS.yMax - BOUNDS.yMin - 280);
  ctx.beginPath();
  ctx.arc(BOUNDS.xMin + 160, PITCH_HEIGHT / 2, 70, -Math.PI/2.5, Math.PI/2.5);
  ctx.stroke();

  // Team B
  ctx.strokeRect(BOUNDS.xMax - 160, BOUNDS.yMin + 140, 160, BOUNDS.yMax - BOUNDS.yMin - 280);
  ctx.beginPath();
  ctx.arc(BOUNDS.xMax - 160, PITCH_HEIGHT / 2, 70, Math.PI - Math.PI/2.5, Math.PI + Math.PI/2.5);
  ctx.stroke();

  // Draw watermarks
  ctx.save();
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  
  const min = Math.floor(timeRemaining / 60);
  const sec = timeRemaining % 60;
  const timeStr = `${min}:${sec < 10 ? '0' : ''}${sec}`;
  
  ctx.fillStyle = 'rgba(255, 255, 255, 0.055)';
  ctx.font = '800 16rem Outfit, sans-serif';
  ctx.fillText(timeStr, PITCH_WIDTH / 2, PITCH_HEIGHT / 2 - 50);
  
  ctx.fillStyle = 'rgba(255, 255, 255, 0.04)';
  ctx.font = '800 4.8rem Outfit, sans-serif';
  ctx.letterSpacing = '12px';
  ctx.fillText('GLIDEGOAL ARENA', PITCH_WIDTH / 2, PITCH_HEIGHT / 2 + 70);
  ctx.restore();

  // Advertising boards around boundaries
  ctx.save();
  ctx.fillStyle = '#1e293b';
  ctx.strokeStyle = '#334155';
  ctx.lineWidth = 2;
  
  // Draw top boards
  for (let i = 120; i < PITCH_WIDTH - 120; i += 180) {
    ctx.fillRect(i, BOUNDS.yMin - 20, 150, 14);
    ctx.strokeRect(i, BOUNDS.yMin - 20, 150, 14);
    
    ctx.fillStyle = 'rgba(16, 185, 129, 0.8)';
    ctx.font = '800 0.65rem Outfit, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('• GLIDEGOAL ARENA •', i + 75, BOUNDS.yMin - 10);
    ctx.fillStyle = '#1e293b';
  }
  ctx.restore();
}

function drawGoalNets() {
  ctx.save();
  ctx.strokeStyle = 'rgba(255,255,255,0.18)';
  ctx.lineWidth = 1;

  const steps = 14;
  const goalDepth = 30;

  // Left Goal Net mesh
  for (let i = 0; i <= steps; i++) {
    const ratio = i / steps;
    const y = GOAL_BOUNDS.yMin + ratio * (GOAL_BOUNDS.yMax - GOAL_BOUNDS.yMin);
    const rip = netDeformationL[Math.min(i, 11)] || 0;
    
    // Draw horizontal nets
    ctx.beginPath();
    ctx.moveTo(BOUNDS.xMin, y);
    ctx.lineTo(BOUNDS.xMin - goalDepth + rip, y);
    ctx.stroke();
  }
  for (let i = 0; i <= 5; i++) {
    const x = BOUNDS.xMin - (i / 5) * goalDepth;
    ctx.beginPath();
    ctx.moveTo(x, GOAL_BOUNDS.yMin);
    ctx.lineTo(x, GOAL_BOUNDS.yMax);
    ctx.stroke();
  }

  // Right Goal Net mesh
  for (let i = 0; i <= steps; i++) {
    const ratio = i / steps;
    const y = GOAL_BOUNDS.yMin + ratio * (GOAL_BOUNDS.yMax - GOAL_BOUNDS.yMin);
    const rip = netDeformationR[Math.min(i, 11)] || 0;
    
    ctx.beginPath();
    ctx.moveTo(BOUNDS.xMax, y);
    ctx.lineTo(BOUNDS.xMax + goalDepth + rip, y);
    ctx.stroke();
  }
  for (let i = 0; i <= 5; i++) {
    const x = BOUNDS.xMax + (i / 5) * goalDepth;
    ctx.beginPath();
    ctx.moveTo(x, GOAL_BOUNDS.yMin);
    ctx.lineTo(x, GOAL_BOUNDS.yMax);
    ctx.stroke();
  }

  // Outer Goal White posts
  ctx.strokeStyle = '#ffffff';
  ctx.lineWidth = 6;
  ctx.lineCap = 'round';
  
  // Left post
  ctx.beginPath();
  ctx.moveTo(BOUNDS.xMin, GOAL_BOUNDS.yMin);
  ctx.lineTo(BOUNDS.xMin - goalDepth, GOAL_BOUNDS.yMin);
  ctx.lineTo(BOUNDS.xMin - goalDepth, GOAL_BOUNDS.yMax);
  ctx.lineTo(BOUNDS.xMin, GOAL_BOUNDS.yMax);
  ctx.stroke();

  // Right post
  ctx.beginPath();
  ctx.moveTo(BOUNDS.xMax, GOAL_BOUNDS.yMin);
  ctx.lineTo(BOUNDS.xMax + goalDepth, GOAL_BOUNDS.yMin);
  ctx.lineTo(BOUNDS.xMax + goalDepth, GOAL_BOUNDS.yMax);
  ctx.lineTo(BOUNDS.xMax, GOAL_BOUNDS.yMax);
  ctx.stroke();
  ctx.restore();
}

function drawBall() {
  ctx.save();
  // Ball Shadow
  ctx.fillStyle = 'rgba(0, 0, 0, 0.4)';
  ctx.beginPath();
  ctx.arc(ball.x + 4, ball.y + 4, ball.radius, 0, Math.PI * 2);
  ctx.fill();

  // Fast ball movement trail
  if (ballTrail.length > 1) {
    ctx.beginPath();
    ctx.moveTo(ballTrail[0].x, ballTrail[0].y);
    for (let i = 1; i < ballTrail.length; i++) {
      ctx.lineTo(ballTrail[i].x, ballTrail[i].y);
    }
    ctx.strokeStyle = 'rgba(255,255,255,0.08)';
    ctx.lineWidth = ball.radius * 2;
    ctx.lineCap = 'round';
    ctx.stroke();
  }

  // 3D Spherical Radial Gradient
  const grad = ctx.createRadialGradient(
    ball.x - ball.radius * 0.35, ball.y - ball.radius * 0.35, 1,
    ball.x, ball.y, ball.radius
  );
  grad.addColorStop(0, '#ffffff');
  grad.addColorStop(0.2, '#fcfcfc');
  grad.addColorStop(0.85, '#d1d5db');
  grad.addColorStop(1, '#9ca3af');

  ctx.fillStyle = grad;
  ctx.beginPath();
  ctx.arc(ball.x, ball.y, ball.radius, 0, Math.PI * 2);
  ctx.fill();
  
  // Outlines
  ctx.strokeStyle = '#1e293b';
  ctx.lineWidth = 1.8;
  ctx.stroke();

  // Soccer stitching panel drawing
  ctx.fillStyle = 'rgba(17, 24, 39, 0.85)';
  ctx.beginPath();
  ctx.arc(ball.x, ball.y, ball.radius * 0.38, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();

  for (let i = 0; i < 5; i++) {
    const angle = (i * Math.PI * 2) / 5;
    ctx.beginPath();
    ctx.moveTo(ball.x + Math.cos(angle) * (ball.radius * 0.38), ball.y + Math.sin(angle) * (ball.radius * 0.38));
    ctx.lineTo(ball.x + Math.cos(angle) * ball.radius, ball.y + Math.sin(angle) * ball.radius);
    ctx.stroke();
  }
  ctx.restore();
}

function drawPlayers() {
  players.forEach(p => {
    if (p.slot === 'unassigned') return;

    const isMe = p.id === socket.id;
    const isTeamA = p.slot.startsWith('teamA');
    const color = isTeamA ? 'var(--accent-blue)' : 'var(--accent-red)';
    const radius = 30;

    ctx.save();
    
    // Glowing shadow
    ctx.shadowBlur = 16;
    ctx.shadowColor = isMe ? '#f59e0b' : color;
    
    // Outer Ring
    ctx.lineWidth = 3.5;
    ctx.strokeStyle = isMe ? '#f59e0b' : color;
    ctx.fillStyle = 'rgba(11, 15, 25, 0.7)';
    ctx.beginPath();
    ctx.arc(p.x, p.y, radius, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();

    ctx.shadowBlur = 0; // Turn off shadows

    // Upgraded Soccer Jersey drawing inside disc
    ctx.save();
    ctx.beginPath();
    ctx.arc(p.x, p.y, radius - 4, 0, Math.PI * 2);
    ctx.clip();
    
    const flag = p.flag || (isTeamA ? 'ARG' : 'BRA');
    
    if (flag === 'BAN') {
      // Bangladesh: Forest green base with a red center circle
      ctx.fillStyle = '#006a4e';
      ctx.fill();
      ctx.fillStyle = '#f42a41';
      ctx.beginPath();
      ctx.arc(p.x, p.y, 14, 0, Math.PI * 2);
      ctx.fill();
    } else if (flag === 'ARG') {
      // Argentina: Light blue and white vertical stripes
      ctx.fillStyle = '#74acdf';
      ctx.fill();
      ctx.fillStyle = '#ffffff';
      for (let offset = -radius; offset < radius; offset += 16) {
        ctx.fillRect(p.x + offset, p.y - radius, 6, radius * 2);
      }
    } else if (flag === 'BRA') {
      // Brazil: Golden yellow base with green trim circle
      ctx.fillStyle = '#fedf00';
      ctx.fill();
      ctx.strokeStyle = '#009c3b';
      ctx.lineWidth = 4.5;
      ctx.beginPath();
      ctx.arc(p.x, p.y, radius - 6, 0, Math.PI * 2);
      ctx.stroke();
    } else if (flag === 'GER') {
      // Germany: White base with horizontal black/red/yellow stripes
      ctx.fillStyle = '#ffffff';
      ctx.fill();
      
      // Black stripe
      ctx.fillStyle = '#000000';
      ctx.fillRect(p.x - radius, p.y - 7, radius * 2, 4);
      // Red stripe
      ctx.fillStyle = '#ff0000';
      ctx.fillRect(p.x - radius, p.y - 3, radius * 2, 4);
      // Gold stripe
      ctx.fillStyle = '#ffcc00';
      ctx.fillRect(p.x - radius, p.y + 1, radius * 2, 4);
    } else if (flag === 'FRA') {
      // France: Deep blue base with a red and white chest sash
      ctx.fillStyle = '#0f2042';
      ctx.fill();
      
      // White sash
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(p.x - radius, p.y - 4, radius * 2, 4);
      // Red sash
      ctx.fillStyle = '#ed2939';
      ctx.fillRect(p.x - radius, p.y, radius * 2, 4);
    } else if (flag === 'POR') {
      // Portugal: Halved green and red (left/right halves)
      ctx.fillStyle = '#ff0000'; // red on right
      ctx.fill();
      ctx.fillStyle = '#006600'; // green on left
      ctx.fillRect(p.x - radius, p.y - radius, radius, radius * 2);
    } else if (flag === 'ESP') {
      // Spain: Red base with yellow horizontal band
      ctx.fillStyle = '#c60b1e';
      ctx.fill();
      ctx.fillStyle = '#ffc400';
      ctx.fillRect(p.x - radius, p.y - 6, radius * 2, 12);
    } else if (flag === 'ITA') {
      // Italy: Azzurri royal blue with white accents
      ctx.fillStyle = '#002f6c';
      ctx.fill();
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.arc(p.x, p.y, radius - 8, 0, Math.PI * 2);
      ctx.stroke();
    }
    
    // Draw player jersey number
    ctx.fillStyle = '#000000';
    ctx.font = '800 0.85rem Outfit, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    
    let number = '10'; // striker default
    if (p.slot.includes('gk')) number = '1';
    else if (p.slot.includes('midfielder')) number = '8';
    else if (p.slot.includes('defender')) number = '4';
    else if (p.slot.includes('forward')) number = '9';
    
    // White backing box for numbers visibility
    ctx.fillStyle = 'rgba(255, 255, 255, 0.88)';
    ctx.beginPath();
    ctx.arc(p.x, p.y, 8, 0, Math.PI * 2);
    ctx.fill();
    
    ctx.fillStyle = '#000';
    ctx.fillText(number, p.x, p.y);
    ctx.restore();

    // Direction indicators (small vector arrow based on disc velocity)
    const vel = Math.sqrt(p.vx * p.vx + p.vy * p.vy);
    if (vel > 0.6) {
      const angle = Math.atan2(p.vy, p.vx);
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate(angle);
      
      // Pointer arrow drawing
      ctx.fillStyle = isMe ? '#f59e0b' : color;
      ctx.beginPath();
      ctx.moveTo(radius + 4, 0);
      ctx.lineTo(radius - 2, -5);
      ctx.lineTo(radius - 2, 5);
      ctx.closePath();
      ctx.fill();
      ctx.restore();
    }

    // Name tag
    ctx.fillStyle = '#ffffff';
    ctx.font = '600 0.85rem Outfit, sans-serif';
    ctx.textAlign = 'center';
    ctx.shadowColor = 'rgba(0,0,0,0.85)';
    ctx.shadowBlur = 4;
    
    let roleTag = ' [ST]';
    if (p.slot.includes('gk')) roleTag = ' [GK]';
    else if (p.slot.includes('midfielder')) roleTag = ' [MID]';
    else if (p.slot.includes('defender')) roleTag = ' [DEF]';
    else if (p.slot.includes('forward')) roleTag = ' [FWD]';
    
    ctx.fillText(p.name + roleTag, p.x, p.y - radius - 8);

    ctx.restore();
  });
}

function gameLoop() {
  particles.forEach((p, idx) => {
    p.update();
    if (p.life <= 0) particles.splice(idx, 1);
  });

  if (gameActive) {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    
    const { scale, offsetX, offsetY } = getPitchScaleFactors();
    
    ctx.save();
    // Render scaling wrapper
    ctx.translate(offsetX, offsetY);
    ctx.scale(scale, scale);
    
    drawPitch();
    drawGoalNets();
    drawBall();
    drawPlayers();
    
    // Draw explosions
    particles.forEach(p => p.draw(ctx));
    
    ctx.restore();
  }
  
  requestAnimationFrame(gameLoop);
}

// Volume click
document.getElementById('soundToggle').addEventListener('click', () => {
  const isMuted = sound.toggleMute();
  document.getElementById('soundIcon').innerText = isMuted ? '🔇' : '🔊';
});

// Canvas resizing
function resizeCanvas() {
  const container = document.getElementById('gameContainer');
  canvas.width = container.clientWidth;
  canvas.height = container.clientHeight;
}

window.addEventListener('resize', resizeCanvas);
window.addEventListener('DOMContentLoaded', () => {
  resizeCanvas();
  
  window.addEventListener('mousemove', handleMouseMove);
  window.addEventListener('touchmove', handleMouseMove, { passive: true });
  
  gameLoop();
});
