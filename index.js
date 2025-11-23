const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const shortid = require('shortid');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static('public'));

const PORT = process.env.PORT || 3000;
const CLUE_TIME_SECONDS = 20;

// YOUR CUSTOM CATEGORIES + ITEMS (omitted for brevity, assume they are still here)
const CATEGORIES = {
    "Movies": [
        "Dark Knight", "Inception", "No Smoking", "Welcome", "Dhamaal", "Phir Hera Pheri",
        "Oppenheimer", "Black Phone", "PK", "Interstellar", "12 Angry Men", "The Godfather"
    ],
    "Sports": [
        "Cricket", "Football", "Hockey", "Kabbadi", "Tennis", "Badminton",
        "Table Tennis", "Basketball", "Baseball", "Boxing", "Golf", "Wrestling"
    ],
    "Professor": [
        "Sharad", "Jyoti", "Kishore", "Manisha", "Balakrishna", "Ashok",
        "Khatija", "Leena", "Pranil", "Vijay", "Niyaz", "Nisha"
    ],
    "Country": [
        "Pakistan", "Nepal", "Sri lanka", "Thailand", "Maldives", "China",
        "Russia", "USA", "Germany", "Australia", "France", "Brazil"
    ],
    "Food": [
        "Dal Chawal", "Dhokla", "Veg Biryani", "Chicken Biryani", "Poha", "Puran Poli",
        "Chole Bhature", "Vada Pav", "Dosa", "Shwarma", "Momos", "Prawns"
    ],
    "Famous Personality": [
        "Nikola Tesla", "Einstein", "Thomas Young", "Huygen", "Newton", "Pablo Picasso",
        "Michael Jackson", "Marie Curie", "Gandhi(Bapu)", "Sigmund Freud", "Muhammad Ali", "Stephen Hawking"
    ],
    "Random Object": [
        "Mirror", "Umbrella", "Pillow", "Clock", "Toothbrush", "Hammer",
        "Soap", "Map", "Helmet", "Bucket", "Charger", "Laptop"
    ],
    "Supreme Leader": [
        "Putin", "Modi Ji", "Mao", "Kim Jong Un", "Elon Musk", "Donald Trump",
        "Swastik(Hither)", "Stalin", "Supreme Leader Aj", "Napoleon", "Genghis Khan", "Alexander"
    ]
};

const rooms = {};

function randomChoice(arr){ 
  return arr[Math.floor(Math.random() * arr.length)];
}

function startNextTurn(roomId) {
    const room = rooms[roomId];
    if (!room) return;

    if (room.timerInterval) {
        clearInterval(room.timerInterval);
    }
    
    const remainingPlayers = Object.entries(room.players)
        .filter(([, p]) => p.clue === null)
        .map(([id]) => id);
    
    if (remainingPlayers.length === 0) {
        room.state = "voting";
        room.currentPlayerId = null;
        io.to(roomId).emit("phase", { phase: "voting" });
        return;
    }

    room.currentPlayerId = randomChoice(remainingPlayers);
    room.state = "clue";
    room.cluesRemaining = remainingPlayers.length;
    
    room.timeRemaining = CLUE_TIME_SECONDS;
    
    io.to(roomId).emit("turnUpdate", { 
        currentPlayerId: room.currentPlayerId, 
        currentPlayerName: room.players[room.currentPlayerId].name,
        timeRemaining: room.timeRemaining,
        cluesRemaining: room.cluesRemaining
    });

    room.timerInterval = setInterval(() => {
        room.timeRemaining--;
        
        io.to(roomId).emit("timerTick", { timeRemaining: room.timeRemaining });

        if (room.timeRemaining <= 0) {
            if (room.players[room.currentPlayerId].clue === null) {
                room.players[room.currentPlayerId].clue = "(Timed Out)";
                
                const clues = Object.entries(room.players).map(([id, p]) => ({
                    name: p.name,
                    clue: p.clue
                }));
                io.to(roomId).emit("cluesUpdate", { clues });
            }
            startNextTurn(roomId); 
        }
    }, 1000);
}


io.on('connection', socket => {
  console.log("Connected:", socket.id);

  socket.on('createRoom', (cb) => {
    const roomId = shortid.generate();
    rooms[roomId] = {
      players: {},
      host: socket.id,
      state: 'lobby',
      secret: null,
      category: null,
      clues: [],
      votes: {},
      currentPlayerId: null,
      timeRemaining: 0,
      timerInterval: null
    };
    socket.join(roomId);
    cb({ roomId });
  });

  // Host Persistence Fix
  socket.on('joinRoom', ({ roomId, name }, cb) => {
    const room = rooms[roomId];
    if (!room) return cb({ ok:false, error:'Room not found' });
    if (Object.keys(room.players).length >= 7)
      return cb({ ok:false, error:'Room full' });
      
    // 1. Check if the joining player's name matches the current host's name
    let isRejoiningHost = false;
    if (room.host && room.players[room.host] && room.players[room.host].name === name) {
        isRejoiningHost = true;
        // Clean up the old (disconnected) host slot to prevent duplication
        delete room.players[room.host]; 
    }
      
    for (const rid of Object.keys(rooms)) {
        if (rooms[rid].players[socket.id]) socket.leave(rid);
    }

    room.players[socket.id] = { name, role: null, clue: null };
    socket.join(roomId);

    // 2. Reassign host if necessary
    if (isRejoiningHost) {
        room.host = socket.id;
    }

    io.to(roomId).emit("lobbyUpdate", {
      players: Object.values(room.players).map(p => p.name),
      host: room.host
    });

    cb({ ok:true });
  });

  // Start Game (The game state is reset here on the server)
  socket.on('startGame', ({ roomId }, cb) => {
    const room = rooms[roomId];
    if (!room) return cb({ ok:false });
    if (socket.id !== room.host) return cb({ ok:false, error:'Only host can start' });

    const playerIds = Object.keys(room.players);
    if (playerIds.length < 3)
      return cb({ ok:false, error:'Need at least 3 players' });

    const impostorId = randomChoice(playerIds);
    playerIds.forEach(id => {
      room.players[id].role = (id === impostorId) ? "impostor" : "investigator";
      room.players[id].clue = null;
    });

    const category = randomChoice(Object.keys(CATEGORIES));
    const secret = randomChoice(CATEGORIES[category]);

    room.category = category;
    room.secret = secret;
    room.clues = [];
    room.votes = {};
    room.state = "clue"; // Set initial state correctly
    
    playerIds.forEach(id => {
      const payload = { 
        role: room.players[id].role,
        category
      };
      if (room.players[id].role === "investigator")
        payload.secret = secret;

      io.to(id).emit("gameStarted", payload);
    });

    startNextTurn(roomId); 
    cb({ ok:true });
  });

  socket.on('submitClue', ({ roomId, clue }, cb) => {
    const room = rooms[roomId];
    if (!room || room.state !== "clue" || socket.id !== room.currentPlayerId) {
        return cb({ ok:false, error: 'Not your turn or wrong phase.' });
    }

    room.players[socket.id].clue = clue || "(empty)";

    const clues = Object.entries(room.players).map(([id, p]) => ({
        name: p.name,
        clue: p.clue
    }));
    io.to(roomId).emit("cluesUpdate", { clues });
    
    startNextTurn(roomId); 

    cb({ ok:true });
  });

  socket.on('chatMessage', ({ roomId, message }) => {
    const room = rooms[roomId];
    if (!room || room.state !== 'voting') return;

    const playerName = room.players[socket.id].name;
    io.to(roomId).emit("newChatMessage", { name: playerName, message });
  });

  // Voting Handler - Modified to fix the last-voter delay (Problem 2 & 3)
  socket.on('castVote', ({ roomId, votedName }, cb) => {
    const room = rooms[roomId];
    if (!room || room.state !== "voting") return cb({ ok:false });
    if (room.votes[socket.id]) return cb({ ok:false, error: 'Already voted' });

    room.votes[socket.id] = votedName;
    
    const totalPlayers = Object.keys(room.players).length;
    const totalVotes = Object.keys(room.votes).length;

    // Notify all players that a vote was cast (Problem 2)
    io.to(roomId).emit('voteCast', { totalVotes, totalPlayers });

    if (totalVotes === totalPlayers) {
      // Logic to calculate final result
      const tally = {};
      Object.values(room.votes).forEach(name => {
        tally[name] = (tally[name] || 0) + 1;
      });

      const maxVotes = Math.max(...Object.values(tally));
      const suspects = Object.keys(tally).filter(n => tally[n] === maxVotes);
      const chosen = suspects[0]; 
      
      const chosenPlayer = Object.entries(room.players)
        .find(([id,p]) => p.name === chosen);

      const chosenId = chosenPlayer ? chosenPlayer[0] : null;
      const impostorId = Object.keys(room.players).find(id => room.players[id].role === "impostor");
      const isImpostor = chosenId === impostorId;
      const impostorName = room.players[impostorId].name;
      
      room.state = "reveal";
      
      // Map votes to names for client display (Problem 2)
      const voteResults = Object.entries(room.votes).map(([voterId, votedName]) => ({
          voter: room.players[voterId].name,
          voted: votedName
      }));

      // Immediately send the reveal event (Problem 3)
      io.to(roomId).emit("reveal", {
        chosen,
        isImpostor,
        impostorName,
        secret: room.secret,
        voteResults // Send the full results
      });
      
      room.votes = {}; 
    }

    cb({ ok:true });
  });

  socket.on('disconnect', () => {
    for (const roomId of Object.keys(rooms)) {
      const room = rooms[roomId];
      if (room.players[socket.id]) {
        delete room.players[socket.id];

        if (socket.id === room.currentPlayerId && room.timerInterval) {
            clearInterval(room.timerInterval);
            startNextTurn(roomId); 
        }

        if (socket.id === room.host) {
            const remainingPlayers = Object.keys(room.players);
            room.host = remainingPlayers.length > 0 ? remainingPlayers[0] : null;
        }

        io.to(roomId).emit("lobbyUpdate", {
          players: Object.values(room.players).map(p => p.name),
          host: room.host
        });

        if (Object.keys(room.players).length === 0) {
            if (room.timerInterval) clearInterval(room.timerInterval);
            delete rooms[roomId];
        }
      }
    }
  });
});

server.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`));
