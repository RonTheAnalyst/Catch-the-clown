const express = require = require('express');
const http = require('http');
const { Server } = require('socket.io');
const shortid = require('shortid');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static('public'));

const PORT = process.env.PORT || 3000;
const CLUE_TIME_SECONDS = 30;

// FINAL & MORE RELATABLE CHARACTER LIST
const CHARACTERS = [
    "Lion", "Wolf", "Owl", "Fox", "Bear", "Cat", "Dog", "Panda", 
    "Shark", "Eagle", "Snake", "Rabbit", "Mouse", "Turtle", "Monkey", 
    "Elephant", "Tiger", "Dolphin", "Horse", "Goat"
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
                    clue: p.clue,
                    character: p.character
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
      timerInterval: null
    };
    socket.join(roomId);
    cb({ roomId });
  });

  // NEW HANDLER: Fetches available characters for the selector instantly
  socket.on('checkCharacters', (roomId, cb) => {
      const room = rooms[roomId];
      const allPlayers = room ? Object.values(room.players) : [];
      const taken = allPlayers.map(p => p.character);
      cb({ available: CHARACTERS, taken: taken });
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

    // Ensure character is valid
    if (!CHARACTERS.includes(selectedCharacter)) {
        return cb({ ok: false, error: 'Invalid character selected.' });
    }
    
    let isRejoiningHost = false;
    let existingPlayerEntry = Object.entries(room.players).find(([, p]) => p.name === name);
    
    if (existingPlayerEntry) {
        const [oldId, playerObj] = existingPlayerEntry;
        
        if (oldId === room.host) { isRejoiningHost = true; }
        
        // Block player if they try to join with a different character name
        if (playerObj.character !== selectedCharacter) {
             return cb({ ok: false, error: `You must rejoin with your original character: ${playerObj.character}` });
        }

        // Clean up old slot
        delete room.players[oldId];
    } else {
        // New player joining, check if character is taken by anyone else
        const currentTakenCharacters = Object.values(room.players).map(p => p.character);
        if (currentTakenCharacters.includes(selectedCharacter)) {
            return cb({ ok: false, error: 'Character is already taken.' });
        }
    }

    room.players[socket.id] = { name, role: null, clue: null, character: selectedCharacter }; // Store character
    socket.join(roomId);

    if (isRejoiningHost) {
        room.host = socket.id;
    }

    const playersPayload = Object.values(room.players).map(p => ({
        name: p.name,
        character: p.character,
        id: Object.keys(room.players).find(id => room.players[id].name === p.name)
    }));

    io.to(roomId).emit("lobbyUpdate", {
      players: playersPayload,
      host: room.host
    });

    cb({ ok:true, character: selectedCharacter });
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

  socket.on('submitClue', ({ roomId, clue }, cb) => {
    const room = rooms[roomId];
    if (!room || room.state !== "clue" || socket.id !== room.currentPlayerId) {
        return cb({ ok:false, error: 'Not your turn or wrong phase.' });
    }

    room.players[socket.id].clue = clue || "(empty)";

    const clues = Object.entries(room.players).map(([id, p]) => ({
        name: p.name,
        clue: p.clue,
        character: p.character
    }));
    io.to(roomId).emit("cluesUpdate", { clues });
    
    startNextTurn(roomId); 

    cb({ ok:true });
  });

  socket.on('chatMessage', ({ roomId, message }) => {
    const room = rooms[roomId];
    if (!room || room.state !== 'voting') return;

    const playerName = room.players[socket.id].name;
    const playerCharacter = room.players[socket.id].character;
    io.to(roomId).emit("newChatMessage", { name: playerName, message, character: playerCharacter });
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
          
          const playerCharacter = room.players[socket.id].character;
          const playerName = room.players[socket.id].name;

          // 1. Completely remove the player's presence
          delete room.players[socket.id]; 
          socket.leave(roomId);
          
          // 2. IMMEDIATE IMPOSTOR RUN WIN CHECK (If game is active)
          if (wasImpostor && (room.state === 'clue' || room.state === 'voting')) {
              room.state = 'reveal';
              
              // Impostor wins by running away (Investigator loss)
              io.to(roomId).emit("reveal", {
                  chosen: playerName, 
                  isImpostor: false, 
                  impostorName: playerName,
                  secret: room.secret,
                  voteResults: [], 
                  ranAway: true 
              });
              if (room.timerInterval) clearInterval(room.timerInterval);
              
              // Clean up other players' state
              Object.keys(room.players).forEach(id => {
                  room.players[id].role = null;
                  room.players[id].clue = null;
              });
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
