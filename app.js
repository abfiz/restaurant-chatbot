const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');

const PORT = process.env.PORT || 3000;

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
	cors: {
		origin: '*'
	}
});

app.set('views', path.join(__dirname, 'views'));
app.set('view engine', 'ejs');
app.use(express.static(path.join(__dirname, 'public')));

// In-memory game store. For production replace with persistent DB.
const games = new Map();

function generateGameId() {
	return Math.random().toString(36).substring(2, 8).toUpperCase();
}

function createGameObject(gameId, ownerSocketId, ownerClientId) {
	const player = {
		id: ownerClientId,
		socketId: ownerSocketId,
		score: 0,
		isGameMaster: true,
		attempts: 3
	};

	return {
		id: gameId,
		gameMasterId: ownerClientId,
		players: [player],
		question: '',
		answer: '',
		status: 'waiting', // waiting, in-progress, ended
		winnerId: null,
		createdAt: Date.now(),
		startTime: null,
		messages: [],
		timerHandle: null
	};
}

function broadcastGame(game) {
	// Send sanitized game data to the room (safer) and to any known socket ids as fallback
	const safe = {
		id: game.id,
		gameMasterId: game.gameMasterId,
		players: game.players.map(p => ({ id: p.id, score: p.score, isGameMaster: p.isGameMaster, attempts: p.attempts })),
		question: game.question,
		status: game.status,
		winnerId: game.winnerId,
		createdAt: game.createdAt,
		startTime: game.startTime,
		messages: game.messages
	};

	try {
		io.in(game.id).emit('game_update', safe);
	} catch (e) {
		// ignore
	}

	// fallback: emit directly to known sockets
	game.players.forEach(p => {
		if (p.socketId) {
			try { io.to(p.socketId).emit('game_update', safe); } catch (e) { }
		}
	});
}

function endGame(gameId, reason = 'timeout') {
	const game = games.get(gameId);
	if (!game) return;

	if (game.timerHandle) {
		clearTimeout(game.timerHandle);
		game.timerHandle = null;
	}

	// If already ended, ignore
	if (game.status !== 'in-progress') return;

	if (reason === 'win') {
		game.status = 'ended';
		// winnerId is already set
	} else {
		// timeout
		game.status = 'ended';
		game.winnerId = null;
	}

	// Notify players
	broadcastGame(game);

	// After a short delay, rotate GM and reset to waiting (if players remain)
	setTimeout(() => {
		const fresh = games.get(gameId);
		if (!fresh) return;
		if (fresh.players.length === 0) {
			games.delete(gameId);
			return;
		}

		// choose next GM by finding current GM index and moving to next
		const currentGMIndex = fresh.players.findIndex(p => p.id === fresh.gameMasterId);
		const nextIndex = (currentGMIndex + 1) % fresh.players.length;
		fresh.players = fresh.players.map((p, idx) => ({ ...p, isGameMaster: idx === nextIndex, attempts: 3 }));
		fresh.gameMasterId = fresh.players[nextIndex].id;
		fresh.status = 'waiting';
		fresh.winnerId = null;
		fresh.question = '';
		fresh.answer = '';
		fresh.startTime = null;
		fresh.messages = [];

		broadcastGame(fresh);
	}, 3000);
}

io.on('connection', (socket) => {
	// Each client should provide a clientId (anonymous id) to track players across reconnects.
	socket.on('hello', (clientId) => {
		socket.data.clientId = clientId || socket.id;
		socket.emit('hello_ack', { clientId: socket.data.clientId });
	});

	socket.on('create_game', (cb) => {
		const clientId = socket.data.clientId || socket.id;
		const gameId = generateGameId();
		const game = createGameObject(gameId, socket.id, clientId);
		games.set(gameId, game);
		socket.join(gameId);
		console.log('[create_game] client', clientId, 'game', gameId);
		broadcastGame(game);
		if (cb) cb({ ok: true, gameId });
	});

	socket.on('join_game', (gameId, cb) => {
		if (!gameId) return cb && cb({ ok: false, error: 'No Game ID' });
		const id = String(gameId).trim().toUpperCase();
		const game = games.get(id);
		const clientId = socket.data.clientId || socket.id;
		if (!game) return cb && cb({ ok: false, error: 'Game not found' });
		if (game.status === 'in-progress') return cb && cb({ ok: false, error: 'Game already in progress' });

		const existing = game.players.find(p => p.id === clientId);
		if (existing) {
			// update socketId
			existing.socketId = socket.id;
		} else {
			game.players.push({ id: clientId, socketId: socket.id, score: 0, isGameMaster: false, attempts: 3 });
		}

		console.log('[join_game] client', clientId, 'joined', id);

		socket.join(id);
		broadcastGame(game);
		if (cb) cb({ ok: true });
	});

	socket.on('leave_game', (gameId, cb) => {
		if (!gameId) return cb && cb({ ok: false });
		const id = gameId.toUpperCase();
		const game = games.get(id);
		const clientId = socket.data.clientId || socket.id;
		if (!game) return cb && cb({ ok: false });

		game.players = game.players.filter(p => p.id !== clientId);

		if (game.players.length === 0) {
			games.delete(id);
		} else {
			if (game.gameMasterId === clientId) {
				// assign first as GM
				game.gameMasterId = game.players[0].id;
				game.players = game.players.map((p, idx) => ({ ...p, isGameMaster: idx === 0 }));
			}
			broadcastGame(game);
		}

		socket.leave(id);
		if (cb) cb({ ok: true });
	});

	socket.on('start_game', ({ gameId, question, answer }, cb) => {
		if (!gameId) return cb && cb({ ok: false, error: 'No game id' });
		const id = gameId.toUpperCase();
		const game = games.get(id);
		const clientId = socket.data.clientId || socket.id;
		if (!game) return cb && cb({ ok: false, error: 'Game not found' });
		if (game.gameMasterId !== clientId) return cb && cb({ ok: false, error: 'Only GM can start' });
		if (game.players.length < 2) return cb && cb({ ok: false, error: 'At least 2 players required' });
		if (!question || !answer) return cb && cb({ ok: false, error: 'Question and answer required' });

		game.question = question;
		game.answer = String(answer).toLowerCase();
		game.status = 'in-progress';
		game.startTime = Date.now();
		game.winnerId = null;
		game.players = game.players.map(p => ({ ...p }));

		// start 60s timer
		if (game.timerHandle) clearTimeout(game.timerHandle);
		game.timerHandle = setTimeout(() => {
			endGame(id, 'timeout');
		}, 60 * 1000);

		broadcastGame(game);
		if (cb) cb({ ok: true });
	});

	socket.on('submit_guess', ({ gameId, guess }, cb) => {
		if (!gameId) return cb && cb({ ok: false, error: 'No game id' });
		const id = gameId.toUpperCase();
		const game = games.get(id);
		const clientId = socket.data.clientId || socket.id;
		if (!game) return cb && cb({ ok: false, error: 'Game not found' });
		if (game.status !== 'in-progress') return cb && cb({ ok: false, error: 'Game not in progress' });

		const playerIndex = game.players.findIndex(p => p.id === clientId);
		if (playerIndex === -1) return cb && cb({ ok: false, error: 'Player not in game' });
		const player = game.players[playerIndex];
		if (player.attempts <= 0) return cb && cb({ ok: false, error: 'No attempts left' });

		const normalizedGuess = String(guess || '').toLowerCase();
		game.messages.push({ senderId: clientId, text: normalizedGuess, timestamp: Date.now() });

		if (normalizedGuess === game.answer) {
			player.score += 10;
			game.players[playerIndex] = player;
			game.winnerId = clientId;
			// end immediately
			endGame(id, 'win');
			broadcastGame(game);
			if (cb) cb({ ok: true, correct: true });
			return;
		}

		player.attempts = Math.max(0, player.attempts - 1);
		game.players[playerIndex] = player;
		broadcastGame(game);
		if (cb) cb({ ok: true, correct: false, attemptsLeft: player.attempts });
	});

	socket.on('send_message', ({ gameId, text }, cb) => {
		if (!gameId) return cb && cb({ ok: false });
		const id = gameId.toUpperCase();
		const game = games.get(id);
		const clientId = socket.data.clientId || socket.id;
		if (!game) return cb && cb({ ok: false });
		game.messages.push({ senderId: clientId, text, timestamp: Date.now() });
		broadcastGame(game);
		if (cb) cb({ ok: true });
	});

	socket.on('disconnect', () => {
		// On disconnect, we don't immediately remove player (allow reconnect). You could implement TTL cleanup here.
	});
});

app.get('/', (req, res) => {
	res.render('index');
});

server.listen(PORT, () => {
	console.log(`Server listening on http://localhost:${PORT}`);
});
