const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

const PORT = process.env.PORT || 3000;

app.use(express.static(__dirname));

const rooms = {};

// Upgraded dimensions for the larger 2D pitch physics boundary
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

function generateRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 6; i++) {
    code += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return code;
}

// Get clean copy of room state without timer/physics interval handles to prevent circular ref socket crash
function getCleanRoomState(room) {
  if (!room) return null;
  return {
    id: room.id,
    players: room.players.map(p => ({
      id: p.id,
      name: p.name,
      slot: p.slot,
      x: p.x,
      y: p.y,
      vx: p.vx,
      vy: p.vy,
      radius: p.radius,
      isHost: p.isHost,
      flag: p.flag,
      isAI: p.isAI || false,
      isSlotAI: p.isSlotAI || false,
      stats: p.stats || { touches: 0, goals: 0 }
    })),
    matchTime: room.matchTime,
    maxPlayers: room.maxPlayers,
    aiGoalkeepers: room.aiGoalkeepers,
    ballSpeedLimit: room.ballSpeedLimit,
    timeRemaining: room.timeRemaining,
    scores: room.scores,
    gameState: room.gameState,
    ball: {
      x: room.ball.x,
      y: room.ball.y,
      vx: room.ball.vx,
      vy: room.ball.vy,
      radius: room.ball.radius
    }
  };
}

// AI Goalkeeper control script
function updateAiGoalkeepers(room) {
  const ball = room.ball;
  
  room.players.forEach(p => {
    if (!p.isAI) return;
    
    if (p.slot === 'teamA_gk') {
      // Team A goalkeeper limits and logic
      let targetX = 150;
      let targetY = 425;
      
      const isBallClose = ball.x < 350 && ball.y >= 200 && ball.y <= 650;
      if (isBallClose) {
        targetX = ball.x;
        targetY = ball.y;
      } else {
        targetX = 150;
        // Position vertically to block angles
        targetY = 425 + (ball.y - 425) * 0.45;
      }
      
      // Clamp to Team A goalkeeper area limits
      targetX = Math.max(120, Math.min(240, targetX));
      targetY = Math.max(290, Math.min(560, targetY));
      
      const dx = targetX - p.x;
      const dy = targetY - p.y;
      const dist = Math.sqrt(dx * dx + dy * dy);
      
      const speedLimit = 8.5;
      if (dist > 0) {
        if (dist > speedLimit) {
          p.vx = (dx / dist) * speedLimit;
          p.vy = (dy / dist) * speedLimit;
        } else {
          p.vx = dx;
          p.vy = dy;
        }
      } else {
        p.vx = 0;
        p.vy = 0;
      }
      
      p.x += p.vx;
      p.y += p.vy;
      
    } else if (p.slot === 'teamB_gk') {
      // Team B goalkeeper limits and logic
      let targetX = 1250;
      let targetY = 425;
      
      const isBallClose = ball.x > 1050 && ball.y >= 200 && ball.y <= 650;
      if (isBallClose) {
        targetX = ball.x;
        targetY = ball.y;
      } else {
        targetX = 1250;
        // Position vertically to block angles
        targetY = 425 + (ball.y - 425) * 0.45;
      }
      
      // Clamp to Team B goalkeeper area limits
      targetX = Math.max(1160, Math.min(1280, targetX));
      targetY = Math.max(290, Math.min(560, targetY));
      
      const dx = targetX - p.x;
      const dy = targetY - p.y;
      const dist = Math.sqrt(dx * dx + dy * dy);
      
      const speedLimit = 8.5;
      if (dist > 0) {
        if (dist > speedLimit) {
          p.vx = (dx / dist) * speedLimit;
          p.vy = (dy / dist) * speedLimit;
        } else {
          p.vx = dx;
          p.vy = dy;
        }
      } else {
        p.vx = 0;
        p.vy = 0;
      }
      
      p.x += p.vx;
      p.y += p.vy;
    }
  });
}

// AI Outfield player movement controller
function updateOutfieldAI(room) {
  const ball = room.ball;
  room.players.forEach(p => {
    if (!p.isAI || p.slot === 'teamA_gk' || p.slot === 'teamB_gk') return;
    const isTeamA = p.slot.startsWith('teamA');
    let targetX, targetY;
    const speed = 5.5;

    if (p.slot.includes('striker')) {
      targetX = ball.x; targetY = ball.y;
    } else if (p.slot.includes('forward')) {
      targetX = isTeamA ? Math.max(ball.x, 700) : Math.min(ball.x, 700);
      targetY = ball.y;
    } else if (p.slot.includes('midfielder')) {
      const d = Math.sqrt((ball.x - p.x) ** 2 + (ball.y - p.y) ** 2);
      targetX = d < 350 ? ball.x : PITCH_WIDTH / 2;
      targetY = d < 350 ? ball.y : PITCH_HEIGHT / 2;
    } else if (p.slot.includes('defender')) {
      const defX = isTeamA ? 320 : PITCH_WIDTH - 320;
      const inZone = isTeamA ? ball.x < 480 : ball.x > PITCH_WIDTH - 480;
      targetX = inZone ? ball.x : defX;
      targetY = inZone ? ball.y : PITCH_HEIGHT / 2;
    } else { return; }

    targetX = Math.max(BOUNDS.xMin + 5, Math.min(BOUNDS.xMax - 5, targetX));
    targetY = Math.max(BOUNDS.yMin + 5, Math.min(BOUNDS.yMax - 5, targetY));
    const dx = targetX - p.x, dy = targetY - p.y;
    const dist = Math.sqrt(dx * dx + dy * dy);
    if (dist > 2) {
      const ms = Math.min(speed, dist);
      p.vx = (dx / dist) * ms; p.vy = (dy / dist) * ms;
      p.x += p.vx; p.y += p.vy;
    } else { p.vx = 0; p.vy = 0; }
  });
}

// Perform 2D physics tick
function updatePhysics(room) {
  if (room.gameState !== 'playing') return;

  // Always run AI movement (handles both auto GK and user-added AI bots)
  updateAiGoalkeepers(room);
  updateOutfieldAI(room);

  const ball = room.ball;

  // 1. Update ball position
  ball.x += ball.vx;
  ball.y += ball.vy;

  // Apply friction
  ball.vx *= ball.damping;
  ball.vy *= ball.damping;

  // Stop ball if velocity is microscopic
  if (Math.abs(ball.vx) < 0.05) ball.vx = 0;
  if (Math.abs(ball.vy) < 0.05) ball.vy = 0;

  // 2. Wall Collisions (Top/Bottom)
  if (ball.y - ball.radius < BOUNDS.yMin) {
    ball.y = BOUNDS.yMin + ball.radius;
    ball.vy = -ball.vy * 0.75;
  } else if (ball.y + ball.radius > BOUNDS.yMax) {
    ball.y = BOUNDS.yMax - ball.radius;
    ball.vy = -ball.vy * 0.75;
  }

  // 3. Goalmouth & Left/Right Wall Collisions
  const insideGoalY = ball.y >= GOAL_BOUNDS.yMin && ball.y <= GOAL_BOUNDS.yMax;
  
  if (insideGoalY) {
    // Check Goal Score
    if (ball.x - ball.radius < BOUNDS.xMin - 20) {
      // Goal for Team B!
      room.scores.B += 1;
      resetPlay(room, 'B');
      return;
    } else if (ball.x + ball.radius > BOUNDS.xMax + 20) {
      // Goal for Team A!
      room.scores.A += 1;
      resetPlay(room, 'A');
      return;
    }
  } else {
    // Bounce off normal left/right walls
    if (ball.x - ball.radius < BOUNDS.xMin) {
      ball.x = BOUNDS.xMin + ball.radius;
      ball.vx = -ball.vx * 0.75;
    } else if (ball.x + ball.radius > BOUNDS.xMax) {
      ball.x = BOUNDS.xMax - ball.radius;
      ball.vx = -ball.vx * 0.75;
    }
  }

  // 4. Collision with player discs
  room.players.forEach(p => {
    if (p.slot === 'unassigned') return;

    const dx = ball.x - p.x;
    const dy = ball.y - p.y;
    const dist = Math.sqrt(dx * dx + dy * dy);
    const minDist = ball.radius + p.radius;

    if (dist < minDist && dist > 0) {
      // Track ball touch & set last toucher for goal credit
      if (!p.stats) p.stats = { touches: 0, goals: 0 };
      p.stats.touches++;
      room.lastTouchedBy = p.id;

      // Overlap correction
      const overlap = minDist - dist;
      const nx = dx / dist;
      const ny = dy / dist;

      // Push ball outside player disc
      ball.x += nx * overlap;
      ball.y += ny * overlap;

      // Elastic collision physics + kick impulse
      const rvx = ball.vx - p.vx;
      const rvy = ball.vy - p.vy;
      const velAlongNormal = rvx * nx + rvy * ny;

      // Only resolve if ball and player are moving towards each other
      if (velAlongNormal < 0) {
        const restitution = 0.6;
        const impulse = -(1 + restitution) * velAlongNormal;
        
        ball.vx += nx * impulse;
        ball.vy += ny * impulse;
      }
      
      // Add kicking velocity boost based on player's speed
      const playerSpeed = Math.sqrt(p.vx * p.vx + p.vy * p.vy);
      const pushMultiplier = playerSpeed > 2 ? 0.35 : 0.15;
      
      ball.vx += nx * (2.0 + playerSpeed * pushMultiplier);
      ball.vy += ny * (2.0 + playerSpeed * pushMultiplier);
      
      // Speed cap for gameplay stability
      const ballSpeed = Math.sqrt(ball.vx * ball.vx + ball.vy * ball.vy);
      const speedLimit = room.ballSpeedLimit || 20;
      if (ballSpeed > speedLimit) {
        ball.vx = (ball.vx / ballSpeed) * speedLimit;
        ball.vy = (ball.vy / ballSpeed) * speedLimit;
      }
    }
  });

  // 5. Broadcast frame state to clients in this room
  const playerStates = room.players.map(p => ({
    id: p.id,
    name: p.name,
    slot: p.slot,
    x: p.x,
    y: p.y,
    flag: p.flag
  }));

  io.to(room.id).emit('physics-tick', {
    ball: { x: ball.x, y: ball.y, vx: ball.vx, vy: ball.vy },
    players: playerStates,
    scores: room.scores
  });
}

function resetPlay(room, scoringTeam) {
  // Credit goal to the last player who touched the ball
  if (room.lastTouchedBy) {
    const scorer = room.players.find(p => p.id === room.lastTouchedBy);
    if (scorer) {
      if (!scorer.stats) scorer.stats = { touches: 0, goals: 0 };
      scorer.stats.goals++;
    }
    room.lastTouchedBy = null;
  }

  room.ball.x = PITCH_WIDTH / 2;
  room.ball.y = PITCH_HEIGHT / 2;
  room.ball.vx = 0;
  room.ball.vy = 0;

  // Reset player disc coordinates to starting slots
  // Reset player disc coordinates to starting slots
  room.players.forEach(p => {
    const slot = p.slot;
    if (slot === 'teamA_striker') { p.x = 600; p.y = 425; }
    else if (slot === 'teamA_gk') { p.x = 180; p.y = 425; }
    else if (slot === 'teamA_midfielder') { p.x = 450; p.y = 250; }
    else if (slot === 'teamA_defender') { p.x = 320; p.y = 600; }
    else if (slot === 'teamA_forward') { p.x = 450; p.y = 600; }
    else if (slot === 'teamB_striker') { p.x = 800; p.y = 425; }
    else if (slot === 'teamB_gk') { p.x = 1220; p.y = 425; }
    else if (slot === 'teamB_midfielder') { p.x = 950; p.y = 600; }
    else if (slot === 'teamB_defender') { p.x = 1080; p.y = 250; }
    else if (slot === 'teamB_forward') { p.x = 950; p.y = 250; }
    
    p.vx = 0;
    p.vy = 0;
  });

  io.to(room.id).emit('goal-scored', {
    scoringTeam,
    scores: room.scores
  });
}

function endGame(room) {
  room.gameState = 'gameover';
  if (room.physicsInterval) clearInterval(room.physicsInterval);
  if (room.timerInterval) clearInterval(room.timerInterval);

  // Capture full player stats (including AI) before cleanup
  const fullPlayerStats = room.players
    .filter(p => p.slot !== 'unassigned')
    .map(p => ({
      name: p.name,
      slot: p.slot,
      isAI: p.isAI || false,
      flag: p.flag || 'BAN',
      stats: p.stats || { touches: 0, goals: 0 }
    }));

  // Remove AI players so they don't clutter the lobby
  room.players = room.players.filter(p => !p.isAI);

  io.to(room.id).emit('game-over', {
    scores: room.scores,
    players: fullPlayerStats
  });
}

// Check if slot selection is valid based on max players limit and AI goalkeeper setting
function isValidSlot(slot, maxPlayers, aiGoalkeepers) {
  if (slot === 'unassigned') return true;
  
  if (aiGoalkeepers) {
    // If AI Goalkeepers is active, GK slots are handled by the AI and are locked for humans
    if (slot === 'teamA_gk' || slot === 'teamB_gk') return false;
    
    // Outfield slots enabled based on player count (AI GK fills GK slot)
    if (maxPlayers === 2) {
      return slot === 'teamA_striker' || slot === 'teamB_striker';
    } else if (maxPlayers === 4) {
      return slot === 'teamA_striker' || slot === 'teamA_midfielder' || 
             slot === 'teamB_striker' || slot === 'teamB_midfielder';
    } else if (maxPlayers === 6) {
      return slot === 'teamA_striker' || slot === 'teamA_midfielder' || slot === 'teamA_defender' || 
             slot === 'teamB_striker' || slot === 'teamB_midfielder' || slot === 'teamB_defender';
    } else if (maxPlayers === 8) {
      return slot === 'teamA_striker' || slot === 'teamA_midfielder' || slot === 'teamA_defender' || slot === 'teamA_forward' ||
             slot === 'teamB_striker' || slot === 'teamB_midfielder' || slot === 'teamB_defender' || slot === 'teamB_forward';
    } else if (maxPlayers === 10) {
      // 5v5: AI GK + Striker + Midfielder + Defender + Forward per team
      return slot === 'teamA_striker' || slot === 'teamA_midfielder' || slot === 'teamA_defender' || slot === 'teamA_forward' ||
             slot === 'teamB_striker' || slot === 'teamB_midfielder' || slot === 'teamB_defender' || slot === 'teamB_forward';
    }
  } else {
    // AI Goalkeepers is disabled, standard slots enablement
    if (slot === 'teamA_forward' || slot === 'teamB_forward') return false; // Forward is locked without AI GK
    
    if (maxPlayers === 2) {
      return slot === 'teamA_striker' || slot === 'teamB_striker';
    } else if (maxPlayers === 4) {
      return slot === 'teamA_striker' || slot === 'teamA_gk' || 
             slot === 'teamB_striker' || slot === 'teamB_gk';
    } else if (maxPlayers === 6) {
      return slot === 'teamA_striker' || slot === 'teamA_gk' || slot === 'teamA_midfielder' || 
             slot === 'teamB_striker' || slot === 'teamB_gk' || slot === 'teamB_midfielder';
    } else if (maxPlayers === 8) {
      return slot === 'teamA_striker' || slot === 'teamA_gk' || slot === 'teamA_midfielder' || slot === 'teamA_defender' ||
             slot === 'teamB_striker' || slot === 'teamB_gk' || slot === 'teamB_midfielder' || slot === 'teamB_defender';
    }
  }
  return false;
}

io.on('connection', (socket) => {
  console.log(`User connected: ${socket.id}`);

  // Create Room
  socket.on('create-room', ({ playerName }) => {
    let roomCode = generateRoomCode();
    while (rooms[roomCode]) {
      roomCode = generateRoomCode();
    }

    rooms[roomCode] = {
      id: roomCode,
      lastTouchedBy: null,
      players: [
        {
          id: socket.id,
          name: playerName,
          slot: 'unassigned',
          x: 0,
          y: 0,
          vx: 0,
          vy: 0,
          radius: 30,
          isHost: true,
          stats: { touches: 0, goals: 0 }
        }
      ],
      matchTime: 60,
      maxPlayers: 2,
      aiGoalkeepers: false,
      ballSpeedLimit: 20,
      timeRemaining: 60,
      scores: { A: 0, B: 0 },
      gameState: 'lobby',
      ball: {
        x: PITCH_WIDTH / 2,
        y: PITCH_HEIGHT / 2,
        vx: 0,
        vy: 0,
        radius: 18,
        damping: 0.985
      },
      physicsInterval: null,
      timerInterval: null
    };

    socket.join(roomCode);
    socket.emit('room-created', {
      roomCode,
      roomState: rooms[roomCode],
      myId: socket.id
    });
    console.log(`Lobby room created: ${roomCode} by ${playerName}`);
  });

  // Join Room
  socket.on('join-room', ({ roomCode, playerName }) => {
    const code = roomCode.toUpperCase().trim();
    const room = rooms[code];

    if (!room) {
      socket.emit('error-msg', { message: 'Room not found. Check the code and try again.' });
      return;
    }

    if (room.players.length >= 8) {
      socket.emit('error-msg', { message: 'Lobby room is full.' });
      return;
    }

    const newPlayer = {
      id: socket.id,
      name: playerName,
      slot: 'unassigned',
      x: 0,
      y: 0,
      vx: 0,
      vy: 0,
      radius: 30,
      isHost: false,
      stats: { touches: 0, goals: 0 }
    };

    room.players.push(newPlayer);
    socket.join(code);
    
    // Send join confirmation back to client
    socket.emit('room-joined', {
      roomCode: code,
      roomState: getCleanRoomState(room),
      myId: socket.id
    });
    
    // Broadcast updated state to all in room
    socket.to(code).emit('room-state-updated', {
      roomState: getCleanRoomState(room)
    });
    console.log(`Player ${playerName} joined lobby: ${code}`);
  });

  // Change slot role
  socket.on('select-slot', ({ roomCode, slot }) => {
    const room = rooms[roomCode];
    if (!room) return;

    // Check if slot selection is valid based on max players setting
    if (!isValidSlot(slot, room.maxPlayers, room.aiGoalkeepers)) {
      socket.emit('slot-error', { message: 'This slot is disabled or controlled by AI!' });
      return;
    }

    // Check if slot is taken (except 'unassigned' slot)
    if (slot !== 'unassigned') {
      const taken = room.players.some(p => p.slot === slot);
      if (taken) {
        socket.emit('slot-error', { message: 'This slot is already taken!' });
        return;
      }
    }

    // Set player's slot
    const player = room.players.find(p => p.id === socket.id);
    if (player) {
      player.slot = slot;
      
      // Default flag assignment based on slot
      if (slot.startsWith('teamA')) {
        player.flag = 'ARG';
      } else if (slot.startsWith('teamB')) {
        player.flag = 'BRA';
      } else {
        player.flag = 'BAN';
      }
      
      // Default coordinate placements on the pitch based on slot
      if (slot === 'teamA_striker') { player.x = 600; player.y = 425; }
      else if (slot === 'teamA_gk') { player.x = 180; player.y = 425; }
      else if (slot === 'teamA_midfielder') { player.x = 450; player.y = 250; }
      else if (slot === 'teamA_defender') { player.x = 320; player.y = 600; }
      else if (slot === 'teamA_forward') { player.x = 450; player.y = 600; }
      else if (slot === 'teamB_striker') { player.x = 800; player.y = 425; }
      else if (slot === 'teamB_gk') { player.x = 1220; player.y = 425; }
      else if (slot === 'teamB_midfielder') { player.x = 950; player.y = 600; }
      else if (slot === 'teamB_defender') { player.x = 1080; player.y = 250; }
      else if (slot === 'teamB_forward') { player.x = 950; player.y = 250; }
      
      io.to(roomCode).emit('room-state-updated', { roomState: getCleanRoomState(room) });
    }
  });

  // Select country jersey flag
  socket.on('select-flag', ({ roomCode, flag }) => {
    const room = rooms[roomCode];
    if (!room) return;

    const player = room.players.find(p => p.id === socket.id);
    if (player) {
      player.flag = flag;
      io.to(roomCode).emit('room-state-updated', { roomState: getCleanRoomState(room) });
    }
  });

  // Change match configuration time (Host only)
  socket.on('update-match-time', ({ roomCode, matchTime }) => {
    const room = rooms[roomCode];
    if (!room) return;
    
    room.matchTime = parseInt(matchTime, 10);
    room.timeRemaining = room.matchTime;
    
    io.to(roomCode).emit('room-state-updated', { roomState: getCleanRoomState(room) });
  });

  // Change match configuration players count limit (Host only)
  socket.on('update-max-players', ({ roomCode, maxPlayers }) => {
    const room = rooms[roomCode];
    if (!room || !room.players.find(p => p.id === socket.id).isHost) return;
    
    const count = parseInt(maxPlayers, 10);
    room.maxPlayers = count;
    
    // Kick out players from slots that are now disabled
    room.players.forEach(p => {
      if (!isValidSlot(p.slot, count, room.aiGoalkeepers)) {
        p.slot = 'unassigned';
        p.x = 0;
        p.y = 0;
      }
    });
    
    io.to(roomCode).emit('room-state-updated', { roomState: getCleanRoomState(room) });
  });

  // Change AI Goalkeepers setting (Host only)
  socket.on('update-ai-goalkeepers', ({ roomCode, aiGoalkeepers }) => {
    const room = rooms[roomCode];
    if (!room || !room.players.find(p => p.id === socket.id).isHost) return;
    
    const enabled = (aiGoalkeepers === 'true' || aiGoalkeepers === true);
    room.aiGoalkeepers = enabled;
    
    // Kick human players from GK slots if AI GKs are enabled
    if (enabled) {
      room.players.forEach(p => {
        if (p.slot === 'teamA_gk' || p.slot === 'teamB_gk') {
          p.slot = 'unassigned';
          p.x = 0;
          p.y = 0;
        }
      });
    }
    
    io.to(roomCode).emit('room-state-updated', { roomState: getCleanRoomState(room) });
  });

  // Change Ball Speed limit (Host only)
  socket.on('update-ball-speed', ({ roomCode, ballSpeed }) => {
    const room = rooms[roomCode];
    if (!room || !room.players.find(p => p.id === socket.id).isHost) return;
    
    room.ballSpeedLimit = parseInt(ballSpeed, 10) || 20;
    
    io.to(roomCode).emit('room-state-updated', { roomState: getCleanRoomState(room) });
  });

  // Start match (Host only)
  socket.on('start-match', ({ roomCode }) => {
    const room = rooms[roomCode];
    if (!room) return;

    room.gameState = 'playing';
    room.timeRemaining = room.matchTime;
    room.scores = { A: 0, B: 0 };
    room.ball.x = PITCH_WIDTH / 2;
    room.ball.y = PITCH_HEIGHT / 2;
    room.ball.vx = 0;
    room.ball.vy = 0;

    // Reset all player stats and touch tracking for fresh match
    room.players.forEach(p => { p.stats = { touches: 0, goals: 0 }; });
    room.lastTouchedBy = null;

    // Spawn AI Goalkeepers if option is enabled
    if (room.aiGoalkeepers) {
      if (!room.players.some(p => p.id === 'ai_gk_a')) {
        room.players.push({
          id: 'ai_gk_a',
          name: 'AI GK A',
          slot: 'teamA_gk',
          x: 180,
          y: 425,
          vx: 0,
          vy: 0,
          radius: 30,
          isHost: false,
          flag: 'ARG',
          isAI: true
        });
      }
      if (!room.players.some(p => p.id === 'ai_gk_b')) {
        room.players.push({
          id: 'ai_gk_b',
          name: 'AI GK B',
          slot: 'teamB_gk',
          x: 1220,
          y: 425,
          vx: 0,
          vy: 0,
          radius: 30,
          isHost: false,
          flag: 'BRA',
          isAI: true
        });
      }
    }

    // Reset placements to slot defaults
    room.players.forEach(p => {
      const slot = p.slot;
      if (slot === 'teamA_striker') { p.x = 600; p.y = 425; }
      else if (slot === 'teamA_gk') { p.x = 180; p.y = 425; }
      else if (slot === 'teamA_midfielder') { p.x = 450; p.y = 250; }
      else if (slot === 'teamA_defender') { p.x = 320; p.y = 600; }
      else if (slot === 'teamA_forward') { p.x = 450; p.y = 600; }
      else if (slot === 'teamB_striker') { p.x = 800; p.y = 425; }
      else if (slot === 'teamB_gk') { p.x = 1220; p.y = 425; }
      else if (slot === 'teamB_midfielder') { p.x = 950; p.y = 600; }
      else if (slot === 'teamB_defender') { p.x = 1080; p.y = 250; }
      else if (slot === 'teamB_forward') { p.x = 950; p.y = 250; }
    });

    // Notify match start
    io.to(roomCode).emit('match-started', { roomState: getCleanRoomState(room) });

    // Start 60 FPS physics engine tick loop
    if (room.physicsInterval) clearInterval(room.physicsInterval);
    room.physicsInterval = setInterval(() => updatePhysics(room), 16);

    // Start 1s countdown timer
    if (room.timerInterval) clearInterval(room.timerInterval);
    room.timerInterval = setInterval(() => {
      room.timeRemaining -= 1;
      io.to(roomCode).emit('timer-updated', { timeRemaining: room.timeRemaining });

      if (room.timeRemaining <= 0) {
        endGame(room);
      }
    }, 1000);
  });

  // Sync client disc coordinates during gameplay
  socket.on('move-disc', ({ roomCode, x, y }) => {
    const room = rooms[roomCode];
    if (!room || room.gameState !== 'playing') return;

    const player = room.players.find(p => p.id === socket.id);
    if (player && player.slot !== 'unassigned') {
      player.vx = x - player.x;
      player.vy = y - player.y;
      player.x = x;
      player.y = y;
    }
  });

  // Host adds AI player to any slot
  socket.on('add-ai-slot-player', ({ roomCode, slot }) => {
    const room = rooms[roomCode];
    if (!room) return;
    const host = room.players.find(p => p.id === socket.id);
    if (!host || !host.isHost) return;
    if (room.players.some(p => p.slot === slot)) {
      socket.emit('slot-error', { message: 'Slot already occupied!' }); return;
    }
    const isTeamA = slot.startsWith('teamA');
    let dx = isTeamA ? 400 : 1000, dy = 425;
    if (slot.includes('striker'))  { dx = isTeamA ? 600 : 800;  dy = 425; }
    else if (slot.includes('gk'))        { dx = isTeamA ? 180 : 1220; dy = 425; }
    else if (slot.includes('midfielder')){ dx = isTeamA ? 450 : 950;  dy = 250; }
    else if (slot.includes('defender'))  { dx = isTeamA ? 320 : 1080; dy = 600; }
    else if (slot.includes('forward'))   { dx = isTeamA ? 450 : 950;  dy = 600; }
    const bots = ['Bolt','Nova','Viper','Storm','Flash','Titan','Apex','Flux'];
    room.players.push({
      id: `ai_${slot}_${Date.now()}`,
      name: `🤖 ${bots[Math.floor(Math.random() * bots.length)]}`,
      slot, x: dx, y: dy, vx: 0, vy: 0, radius: 30,
      isHost: false, flag: isTeamA ? 'ARG' : 'BRA',
      isAI: true, isSlotAI: true,
      stats: { touches: 0, goals: 0 }
    });
    io.to(roomCode).emit('room-state-updated', { roomState: getCleanRoomState(room) });
  });

  // Host removes AI player from a slot
  socket.on('remove-ai-slot-player', ({ roomCode, slot }) => {
    const room = rooms[roomCode];
    if (!room) return;
    const host = room.players.find(p => p.id === socket.id);
    if (!host || !host.isHost) return;
    room.players = room.players.filter(p => !(p.slot === slot && p.isSlotAI));
    io.to(roomCode).emit('room-state-updated', { roomState: getCleanRoomState(room) });
  });

  // Disconnection handler
  socket.on('disconnect', () => {
    console.log(`User disconnected: ${socket.id}`);
    for (const code in rooms) {
      const room = rooms[code];
      const playerIndex = room.players.findIndex(p => p.id === socket.id);

      if (playerIndex !== -1) {
        const p = room.players[playerIndex];
        room.players.splice(playerIndex, 1);

        if (room.players.length === 0) {
          if (room.physicsInterval) clearInterval(room.physicsInterval);
          if (room.timerInterval) clearInterval(room.timerInterval);
          delete rooms[code];
          console.log(`Room closed since all players left: ${code}`);
        } else {
          if (p.isHost && room.players.length > 0) {
            const nextHuman = room.players.find(pl => !pl.isAI);
            if (nextHuman) {
              nextHuman.isHost = true;
            }
          }
          io.to(code).emit('room-state-updated', { roomState: getCleanRoomState(room) });
        }
        break;
      }
    }
  });
});

server.listen(PORT, () => {
  console.log(`GlideGoal Arena Server running on http://localhost:${PORT}`);
});
