const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const shortid = require('shortid');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// Serve static files from the 'public' directory (we assume index.html is there)
app.use(express.static('public'));

const PORT = process.env.PORT || 3000;

// YOUR CUSTOM CATEGORIES + ITEMS
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

// In-memory rooms
const rooms = {};

function randomChoice(arr){ 
  return arr[Math.floor(Math.random() * arr.length)];
}

io.on('connection', socket => {
  console.log("Connected:", socket.id);

  // Create Room
  socket.on('createRoom', (cb) => {
    const roomId = shortid.generate();
    rooms[roomId] = {
      players: {},
      host: socket.id,
      state: 'lobby',
      secret: null,
      category: null,
      clues: [],
      votes: {}
    };
    // Ensure the new player joins the room immediately
    socket.join(roomId);
    cb({ roomId });
  });

  // Join Room
  socket.on('joinRoom', ({ roomId, name }, cb) => {
    const room = rooms[roomId];
    if (!room) return cb({ ok:false, error:'Room not found' });
    if (Object.keys(room.players).length >= 7)
      return cb({ ok:false, error:'Room full' });

    // Handle case where player might already be in another room (optional)
    for (const rid of Object.keys(rooms)) {
        if (rooms[rid].players[socket.id]) socket.leave(rid);
    }

    room.players[socket.id] = { name, role: null, clue: null };
    socket.join(roomId);

    io.to(roomId).emit("lobbyUpdate", {
      players: Object.values(room.players).map(p => p.name),
      host: room.host
    });

    cb({ ok:true });
  });

  // Start Game
  socket.on('startGame', ({ roomId }, cb) => {
    const room = rooms[roomId];
    if (!room) return cb({ ok:false });
    if (socket.id !== room.host) return cb({ ok:false, error:'Only host can start' });

    const playerIds = Object.keys(room.players);
    if (playerIds.length < 3)
      return cb({ ok:false, error:'Need at least 3 players' });

    // Assign one impostor
    const impostorId = randomChoice(playerIds);
    playerIds.forEach(id => {
      room.players[id].role = (id === impostorId) ? "impostor" : "investigator";
      room.players[id].clue = null;
    });

    // Pick category + secret
    const category = randomChoice(Object.keys(CATEGORIES));
    const secret = randomChoice(CATEGORIES[category]);

    room.category = category;
    room.secret = secret;
    room.state = "clue";
    room.clues = [];
    room.votes = {};

    // Send role info to each player individually
    playerIds.forEach(id => {
      const payload = { 
        role: room.players[id].role,
        category
      };
      if (room.players[id].role === "investigator")
        payload.secret = secret;

      io.to(id).emit("gameStarted", payload);
    });

    io.to(roomId).emit("phase", { phase:"clue", category });
    cb({ ok:true });
  });

  // Submit Clue
  socket.on('submitClue', ({ roomId, clue }, cb) => {
    const room = rooms[roomId];
    if (!room || room.state !== "clue") return cb({ ok:false });

    room.players[socket.id].clue = clue || "(empty)";

    const allDone = Object.values(room.players).every(p => p.clue !== null);

    const clues = Object.entries(room.players).map(([id,p]) => ({
      name: p.name,
      clue: p.clue
    }));

    io.to(roomId).emit("cluesUpdate", { clues });

    if (allDone) {
      room.state = "voting";
      io.to(roomId).emit("phase", { phase:"voting" });
    }

    cb({ ok:true });
  });

  // --- NEW CHAT HANDLER ---
  socket.on('chatMessage', ({ roomId, message }) => {
    const room = rooms[roomId];
    if (!room || room.state !== 'voting') return; // Only allow chat during voting

    const playerName = room.players[socket.id].name;

    // Broadcast the message to all clients in the room
    io.to(roomId).emit("newChatMessage", { name: playerName, message });
  });
  // --- END NEW CHAT HANDLER ---

  // Voting
  socket.on('castVote', ({ roomId, votedName }, cb) => {
    const room = rooms[roomId];
    if (!room || room.state !== "voting") return cb({ ok:false });

    // Prevent voting if already voted
    if (room.votes[socket.id]) return cb({ ok:false, error: 'Already voted' });

    room.votes[socket.id] = votedName;

    const totalPlayers = Object.keys(room.players).length;
    const totalVotes = Object.keys(room.votes).length;

    if (totalVotes === totalPlayers) {
      const tally = {};

      Object.values(room.votes).forEach(name => {
        tally[name] = (tally[name] || 0) + 1;
      });

      const maxVotes = Math.max(...Object.values(tally));
      const suspects = Object.keys(tally).filter(n => tally[n] === maxVotes);

      // Simple handling for ties: pick the first one
      const chosen = suspects[0]; 
      
      const chosenPlayer = Object.entries(room.players)
        .find(([id,p]) => p.name === chosen);

      const chosenId = chosenPlayer ? chosenPlayer[0] : null;
      const isImpostor = chosenId && room.players[chosenId].role === "impostor";

      const impostorName = Object.values(room.players).find(p => p.role === "impostor").name;
      
      room.state = "reveal";
      
      // Clear votes for next round (optional)
      room.votes = {}; 

      io.to(roomId).emit("reveal", {
        chosen,
        isImpostor,
        impostorName,
        secret: room.secret
      });
    }

    cb({ ok:true });
  });

  socket.on('disconnect', () => {
    for (const roomId of Object.keys(rooms)) {
      const room = rooms[roomId];
      if (room.players[socket.id]) {
        delete room.players[socket.id];

        // If the host disconnects, ideally transfer host or end game (simplified here)
        if (socket.id === room.host) {
            const remainingPlayers = Object.keys(room.players);
            room.host = remainingPlayers.length > 0 ? remainingPlayers[0] : null;
        }

        io.to(roomId).emit("lobbyUpdate", {
          players: Object.values(room.players).map(p => p.name),
          host: room.host
        });

        if (Object.keys(room.players).length === 0)
          delete rooms[roomId];
      }
    }
  });
});

server.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`));
