const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const shortid = require('shortid');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static('public'));

const PORT = process.env.PORT || 3000;
const CLUE_TIME_SECONDS = 30;

// NEW: Character List
const CHARACTERS = [
    "Wombat", "Narwhal", "Sloth", "Capybara", "Red Panda", "Axolotl", 
    "Quokka", "Pangolin", "Alpaca", "Fennec Fox", "Hedgehog", "Koala",
    "Blobfish", "Toucan", "Platypus", "Puffin", "Manatee", "Llama",
    "Tarsier", "Okapia"
];

// YOUR CUSTOM CATEGORIES + ITEMS (Kept for brevity, assumed correct)
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
    
    // Check if total players is 0, if so, end the game/room state
    if (Object.keys(room.players).length === 0) {
        delete rooms[roomId];
        return;
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
      timerInterval: null,
      takenCharacters: [] // NEW: Initialize taken characters
    };
    socket.join(roomId);
    cb({ roomId });
  });

  // FIX: Host Persistence & Mid-Game Block & Character Assignment
  socket.on('joinRoom', ({ roomId, name, selectedCharacter }, cb) => {
    const room = rooms[roomId];
    if (!room) return cb({ ok:false, error:'Room not found' });
      
    // BLOCK: Do not allow joining if game is active
    if (room.state !== 'lobby' && room.state !== 'reveal') {
        return cb({ 
            ok: false, 
            error: 'A game is currently in progress. Please wait for the next round!' 
        });
    }

    if (Object.keys(room.players).length >= 7)
      return cb({ ok:false, error:'Room full' });

    // Ensure character is valid and not taken
    if (!CHARACTERS.includes(selectedCharacter)) {
        return cb({ ok: false, error: 'Invalid character selected.' });
    }
    
    // Check if player is rejoining (host or not)
    let isRejoiningHost = false;
    let oldCharacter = null;
    
    // 1. Find player by name to check for host/rejoin scenario
    const existingPlayerEntry = Object.entries(room.players).find(([, p]) => p.name === name);
    
    if (existingPlayerEntry) {
        const [oldId, playerObj] = existingPlayerEntry;
        
        // If the player is the host reloading/rejoining
        if (oldId === room.host) {
            isRejoiningHost = true;
        }
        oldCharacter = playerObj.character;

        // If character selection changes during rejoin, ensure the old one is freed
        if (oldCharacter !== selectedCharacter) {
             return cb({ ok: false, error: 'Cannot change character after initial assignment.' });
        }

        // Clean up old slot
        delete room.players[oldId];
    } else {
        // New player joining, check if character is taken by someone else
        const currentTakenCharacters = Object.values(room.players).map(p => p.character);
        if (currentTakenCharacters.includes(selectedCharacter)) {
            return cb({ ok: false, error: 'Character is already taken.' });
        }
    }

    // 2. Assign player slot
    room.players[socket.id] = { name, role: null, clue: null, character: selectedCharacter }; // Store character
    socket.join(roomId);

    // 3. Reassign host if necessary
    if (isRejoiningHost) {
        room.host = socket.id;
    }

    // 4. Update the character list sent to client
    const playersPayload = Object.values(room.players).map(p => ({
        name: p.name,
        character: p.character,
        id: Object.keys(room.players).find(id => room.players[id].name === p.name) // Send ID for host check on client
    }));

    io.to(roomId).emit("lobbyUpdate", {
      players: playersPayload,
      host: room.host
    });

    cb({ ok:true, character: selectedCharacter }); // Return selected character
  });

  // NEW: Handle character selection on new join (before hitting 'join room')
  socket.on('checkCharacters', (roomId, cb) => {
      const room = rooms[roomId];
      if (!room) return cb({ available: CHARACTERS });

      const taken = Object.values(room.players).map(p => p.character);
      cb({ available: CHARACTERS, taken: taken });
  });

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

    // Reset game state
    room.category = category;
    room.secret = secret;
    room.clues = [];
    room.votes = {};
    room.state = "clue";
    
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
  
  // (submitClue, chatMessage, castVote handlers remain the same)
  socket.on('submitClue', ({ roomId, clue }, cb) => {
    const room = rooms[roomId];
    if (!room || room.state !== "clue" || socket.id !== room.currentPlayerId) {
        return cb({ ok:false, error: 'Not your turn or wrong phase.' });
    }

    room.players[socket.id].clue = clue || "(empty)";

    const clues = Object.entries(room.players).map(([id, p]) => ({
        name: p.name,
        clue: p.clue,
        character: p.character // Send character with clue
    }));
    io.to(roomId).emit("cluesUpdate", { clues });
    
    startNextTurn(roomId); 

    cb({ ok:true });
  });
  
  socket.on('chatMessage', ({ roomId, message }) => {
    const room = rooms[roomId];
    if (!room || room.state !== 'voting') return;

    const playerName = room.players[socket.id].name;
    const playerCharacter = room.players[socket.id].character; // Get character
    io.to(roomId).emit("newChatMessage", { name: playerName, message, character: playerCharacter }); // Send character
  });

  socket.on('castVote', ({ roomId, votedName }, cb) => {
    const room = rooms[roomId];
    if (!room || room.state !== "voting") return cb({ ok:false });
    if (room.votes[socket.id]) return cb({ ok:false, error: 'Already voted' });

    room.votes[socket.id] = votedName;
    
    const totalPlayers = Object.keys(room.players).length;
    const totalVotes = Object.keys(room.votes).length;

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
      
      const voteResults = Object.entries(room.votes).map(([voterId, votedName]) => ({
          voter: room.players[voterId].name,
          voted: votedName
      }));

      io.to(roomId).emit("reveal", {
        chosen,
        isImpostor,
        impostorName,
        secret: room.secret,
        voteResults
      });
      
      room.votes = {}; 
    }

    cb({ ok:true });
  });

  // FIX: Robust Disconnect & Host Transfer + Impostor Run Win
  socket.on('disconnect', () => {
    for (const roomId of Object.keys(rooms)) {
      const room = rooms[roomId];

      if (room.players[socket.id]) {
          const wasHost = (socket.id === room.host);
          const wasImpostor = (room.players[socket.id].role === 'impostor');
          
          // 1. Completely remove the player's presence
          delete room.players[socket.id]; 
          socket.leave(roomId);
          
          // 2. IMMEDIATE IMPOSTOR RUN WIN CHECK (If game is active)
          if (wasImpostor && (room.state === 'clue' || room.state === 'voting')) {
              room.state = 'reveal';
              // Impostor wins by running away (Investigator loss)
              io.to(roomId).emit("reveal", {
                  chosen: room.players[socket.id].name, // The one who left
                  isImpostor: false, // Investigators failed to catch them
                  impostorName: room.players[socket.id].name,
                  secret: room.secret,
                  voteResults: [], // No vote data
                  ranAway: true // NEW FLAG
              });
              if (room.timerInterval) clearInterval(room.timerInterval);
              // Clean up other players' state
              Object.keys(room.players).forEach(id => {
                  room.players[id].role = null;
                  room.players[id].clue = null;
              });
              
              // Proceed with standard cleanup after broadcast
          }

          // 3. Host Transfer
          if (wasHost && Object.keys(room.players).length > 0) {
              room.host = Object.keys(room.players)[0];
          } else if (Object.keys(room.players).length === 0) {
              room.host = null;
          }
          
          // 4. Check and handle turn transfer
          if (socket.id === room.currentPlayerId && room.timerInterval && room.state === 'clue') {
              clearInterval(room.timerInterval);
              startNextTurn(roomId); 
          }

          // 5. Update the lobby for remaining players
          const playersPayload = Object.values(room.players).map(p => ({
              name: p.name,
              character: p.character,
              id: Object.keys(room.players).find(id => room.players[id].name === p.name)
          }));
          io.to(roomId).emit("lobbyUpdate", {
              players: playersPayload,
              host: room.host
          });

          // 6. Delete the room if it's empty
          if (Object.keys(room.players).length === 0) {
              if (room.timerInterval) clearInterval(room.timerInterval);
              delete rooms[roomId];
          }
      }
    }
  });
});

server.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`));
