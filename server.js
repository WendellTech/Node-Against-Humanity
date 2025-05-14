const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const fs = require('fs').promises;
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = socketIo(server);

const PORT = process.env.PORT || 3000;
const MAX_HAND_SIZE = 10;

// --- Configuration ---
let config = {
    allowSameNames: false,
    roomsFunctionality: true // Default values
};

class CAHDeck {
    constructor() {
        this.deck = null;
        this.compactSrc = undefined;
        this.fullSrc = undefined;
    }

    _hydrateCompact(json) {
        let hydratedPacks = [];

        if (!json) {
            console.error("Error in _hydrateCompact: Parsed JSON is null or undefined.");
            return [];
        }

        if (!json.metadata || typeof json.metadata !== 'object') {
            console.error("Error in _hydrateCompact: 'json.metadata' is missing or not a valid object. Loaded JSON structure might be incorrect. Expected a top-level 'metadata' object containing pack information.");
            console.log("Loaded JSON keys:", Object.keys(json));
            return [];
        }

        if (!json.white || !Array.isArray(json.white)) {
            console.error("Error in _hydrateCompact: 'json.white' (global white cards list) is missing or not a valid array.");
            return [];
        }
        if (!json.black || !Array.isArray(json.black)) {
            console.error("Error in _hydrateCompact: 'json.black' (global black cards list) is missing or not a valid array.");
            return [];
        }

        const packIds = Object.keys(json.metadata);
        for (let i = 0; i < packIds.length; i++) {
            const packId = packIds[i];
            const packData = json.metadata[packId];

            if (!packData || typeof packData.name !== 'string' ||
                !Array.isArray(packData.white) || !Array.isArray(packData.black)) {
                console.warn(`Skipping malformed pack data for packId '${packId}' in cards.json. Pack data:`, packData);
                continue;
            }

            let hydratedPack = {
                name: packData.name,
                official: packData.official, 
                description: packData.description,
                white: [],
                black: []
            };
            if (packData.icon) hydratedPack.icon = packData.icon;

            const currentPackIndexInHydratedArray = hydratedPacks.length;


            hydratedPack.white = packData.white.map((cardIndex) => { 
                if (typeof json.white[cardIndex] === 'undefined') {
                    console.warn(`Warning: White card index ${cardIndex} not found in global white cards for pack '${packData.name}'. Skipping card.`);
                    return null;
                }
                return Object.assign(
                    {},
                    { text: json.white[cardIndex] },
                    { pack: currentPackIndexInHydratedArray }, 
                    packData.icon ? { icon: packData.icon } : {}
                );
            }).filter(card => card !== null);

            hydratedPack.black = packData.black.map((cardIndex) => { 
                if (typeof json.black[cardIndex] === 'undefined' || typeof json.black[cardIndex].text !== 'string' || typeof json.black[cardIndex].pick !== 'number') {
                    console.warn(`Warning: Black card index ${cardIndex} not found or malformed (missing text/pick) in global black cards for pack '${packData.name}'. Skipping card.`);
                    return null;
                }
                return Object.assign(
                    {},
                    json.black[cardIndex],
                    { pack: currentPackIndexInHydratedArray }, 
                    packData.icon ? { icon: packData.icon } : {}
                );
            }).filter(card => card !== null);

            hydratedPacks.push(hydratedPack);
        }
        return hydratedPacks;
    }

    async _loadDeck() {
        if (typeof this.compactSrc !== "undefined") {
            try {
                const fileContent = await fs.readFile(this.compactSrc, 'utf-8');
                const json = JSON.parse(fileContent);
                this.deck = this._hydrateCompact(json);
            } catch (err) {
                console.error("Error loading or parsing compact deck from file:", this.compactSrc, err);
                throw Error(`Failed to load compact deck from source. Original error: ${err.message}`);
            }
        } else if (typeof this.fullSrc !== "undefined") {
            try {
                const fileContent = await fs.readFile(this.fullSrc, 'utf-8');
                this.deck = JSON.parse(fileContent); 
            } catch (err) {
                console.error("Error loading or parsing full deck from file:", this.fullSrc, err);
                throw Error(`Failed to load full deck from source. Original error: ${err.message}`);
            }
        } else {
            throw Error("No source specified, please use CAHDeck.fromCompact(src) or CAHDeck.fromFull(src) to make your objects.");
        }
    }

    static async fromCompact(compactSrc) {
        let n = new CAHDeck();
        n.compactSrc = compactSrc;
        await n._loadDeck();
        return n;
    }

    static async fromFull(fullSrc) {
        let n = new CAHDeck();
        n.fullSrc = fullSrc;
        await n._loadDeck();
        return n;
    }

    listPacks() {
        let packs = [];
        if (!this.deck) return packs;
        for (let id = 0; id < this.deck.length; id++) {
            const { name, official, description, icon, white, black } = this.deck[id];
            let pack = {
                id, name, official, description,
                counts: {
                    white: white.length,
                    black: black.length,
                    total: white.length + black.length,
                },
            };
            if (icon) pack.icon = icon;
            packs.push(pack);
        }
        return packs;
    }

    getPack(index) {
        if (!this.deck) return undefined;
        return this.deck[index];
    }

    getPacks(indexes) {
        if (!this.deck) return { white: [], black: [] };
        if (typeof indexes === "undefined" || indexes.length === 0) {
            indexes = this.deck.map((pack, index) => index);
        }

        let white = [];
        let black = [];
        let cardIdCounter = 0; 

        for (let packIndex of indexes) {
            const packNum = parseInt(packIndex, 10);
            if (typeof this.deck[packNum] !== "undefined") {
                white.push(...this.deck[packNum].white.map(card => ({ ...card, id: `w_${cardIdCounter++}` })));
                black.push(...this.deck[packNum].black.map(card => ({ ...card, id: `b_${cardIdCounter++}` })));
            } else {
                console.warn(`Pack index ${packNum} requested but not found in loaded deck.`);
            }
        }
        return { white, black };
    }
}

let globalCAHDeck;
const lobbies = {}; 

function generateLobbyCode() {
    let code;
    do {
        code = Math.random().toString(36).substring(2, 7).toUpperCase();
    } while (lobbies[code]);
    return code;
}

function shuffleArray(array) {
    for (let i = array.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [array[i], array[j]] = [array[j], array[i]];
    }
}

function getLobbyPlayer(lobby, playerId) {
    return lobby.players.find(p => p.id === playerId);
}

function broadcastLobbyState(lobbyCode) {
    const lobby = lobbies[lobbyCode];
    if (!lobby) return;

    const publicLobbyState = {
        code: lobbyCode,
        players: lobby.players.map(p => ({ 
            id: p.id,
            name: p.name, 
            score: p.score, 
            isCzar: p.id === lobby.czarId, 
            hasSubmitted: !!p.submittedCards 
        })),
        hostId: lobby.hostId,
        gameState: lobby.gameState,
        settings: lobby.settings, // includes isPrivate for host display if needed
        currentBlackCard: lobby.currentBlackCard,
        roundSubmissions: lobby.gameState === 'judging' ? lobby.roundSubmissions.map(sub => ({
            playerId: sub.playerId,
            playerName: sub.playerName,
            cards: sub.cards
        })) : null,
        roundWinnerInfo: lobby.roundWinnerInfo, 
        czarId: lobby.czarId,
        czarName: lobby.czarId ? lobby.players.find(p => p.id === lobby.czarId)?.name : null
    };
    io.to(lobbyCode).emit('lobbyUpdate', publicLobbyState);
}

function dealWhiteCards(lobby, player, count) {
    for (let i = 0; i < count; i++) {
        if (lobby.whiteDeck.length === 0) {
            if (lobby.whiteDiscard.length === 0) break; 
            lobby.whiteDeck = [...lobby.whiteDiscard];
            lobby.whiteDiscard = [];
            shuffleArray(lobby.whiteDeck);
        }
        if (lobby.whiteDeck.length > 0) {
            player.hand.push(lobby.whiteDeck.pop());
        }
    }
}

function startNextRound(lobbyCode) {
    const lobby = lobbies[lobbyCode];
    if (!lobby) return;

    lobby.gameState = 'playing';
    lobby.roundSubmissions = [];
    lobby.roundWinnerInfo = null;
    lobby.players.forEach(p => p.submittedCards = null);

    const currentCzarIndex = lobby.players.findIndex(p => p.id === lobby.czarId);
    lobby.czarId = lobby.players[(currentCzarIndex + 1) % lobby.players.length].id;

    if (lobby.blackDeck.length === 0) {
        if (lobby.blackDiscard.length === 0) {
            io.to(lobbyCode).emit('gameOver', { message: "No more black cards!", players: lobby.players });
            lobby.gameState = 'gameOver';
            broadcastLobbyState(lobbyCode);
            return;
        }
        lobby.blackDeck = [...lobby.blackDiscard];
        lobby.blackDiscard = [];
        shuffleArray(lobby.blackDeck);
    }
    if (lobby.currentBlackCard) lobby.blackDiscard.push(lobby.currentBlackCard);
    lobby.currentBlackCard = lobby.blackDeck.pop();

    lobby.players.forEach(player => {
        const cardsNeeded = MAX_HAND_SIZE - player.hand.length;
        if (cardsNeeded > 0) {
            dealWhiteCards(lobby, player, cardsNeeded);
        }
        io.to(player.id).emit('handUpdate', player.hand);
    });

    broadcastLobbyState(lobbyCode);
}


io.on('connection', (socket) => {
    console.log('A user connected:', socket.id);
    socket.emit('serverConfig', config); // Send config to client on connect

    socket.on('getPackList', async (callback) => {
        if (globalCAHDeck) {
            callback(globalCAHDeck.listPacks());
        } else {
            callback([]);
        }
    });

    socket.on('createLobby', ({ playerName, settings }, callback) => {
        const lobbyCode = generateLobbyCode();
        lobbies[lobbyCode] = {
            code: lobbyCode,
            players: [],
            hostId: socket.id,
            gameState: 'waiting',
            settings: {
                scoreToWin: settings?.scoreToWin || 7,
                maxPlayers: settings?.maxPlayers || 10,
                selectedPackIndexes: settings?.selectedPackIndexes || [0],
                isPrivate: config.roomsFunctionality ? (settings?.isPrivate || false) : true
            },
            whiteDeck: [],
            blackDeck: [],
            whiteDiscard: [],
            blackDiscard: [],
            currentBlackCard: null,
            czarId: null,
            roundSubmissions: [],
            roundWinnerInfo: null
        };
        socket.join(lobbyCode);
        const player = { id: socket.id, name: playerName, score: 0, hand: [], submittedCards: null };
        lobbies[lobbyCode].players.push(player);
        
        callback({ success: true, lobbyCode });
        broadcastLobbyState(lobbyCode);
        console.log(`Lobby ${lobbyCode} created by ${playerName}. Private: ${lobbies[lobbyCode].settings.isPrivate}`);
    });

    socket.on('joinLobby', ({ lobbyCode, playerName }, callback) => {
        const lobby = lobbies[lobbyCode];
        if (!lobby) {
            return callback({ success: false, message: 'Lobby not found.' });
        }
        if (lobby.players.length >= lobby.settings.maxPlayers) {
            return callback({ success: false, message: 'Lobby is full.' });
        }
        if (lobby.gameState !== 'waiting') {
             return callback({ success: false, message: 'Game has already started.' });
        }
        if (!config.allowSameNames && lobby.players.some(p => p.name.toLowerCase() === playerName.toLowerCase())) {
            return callback({ success: false, message: 'Player name already taken in this lobby.' });
        }


        socket.join(lobbyCode);
        const player = { id: socket.id, name: playerName, score: 0, hand: [], submittedCards: null };
        lobby.players.push(player);
        
        callback({ success: true, lobbyCode, settings: lobby.settings, packList: globalCAHDeck.listPacks() });
        broadcastLobbyState(lobbyCode);
        io.to(socket.id).emit('handUpdate', player.hand); 
        console.log(`${playerName} joined lobby ${lobbyCode}`);
    });
    
    socket.on('getPublicLobbies', (callback) => {
        if (!config.roomsFunctionality) {
            console.log('Room functionality disabled, returning empty list for getPublicLobbies.');
            return callback([]);
        }
        const publicLobbies = Object.values(lobbies)
            .filter(lobby =>
                !lobby.settings.isPrivate &&
                lobby.gameState === 'waiting' &&
                lobby.players.length < lobby.settings.maxPlayers
            )
            .map(lobby => ({
                code: lobby.code,
                hostName: lobby.players.find(p => p.id === lobby.hostId)?.name || 'Unknown Host',
                playerCount: lobby.players.length,
                settings: { 
                    maxPlayers: lobby.settings.maxPlayers,
                    scoreToWin: lobby.settings.scoreToWin,
                    selectedPackNames: lobby.settings.selectedPackIndexes
                        .map(idx => globalCAHDeck.listPacks().find(p => p.id === idx)?.name || `Pack ${idx}`)
                }
            }));
        callback(publicLobbies);
    });

    socket.on('updateSettings', ({ lobbyCode, settings }) => {
        const lobby = lobbies[lobbyCode];
        if (lobby && lobby.hostId === socket.id && lobby.gameState === 'waiting') {
            // Make sure isPrivate can be updated if roomsFunctionality is on
            if (config.roomsFunctionality && typeof settings.isPrivate === 'boolean') {
                 lobby.settings.isPrivate = settings.isPrivate;
            }
            // other settings can be updated as before
            lobby.settings = { ...lobby.settings, ...settings };
            broadcastLobbyState(lobbyCode);
        }
    });

    socket.on('startGame', ({ lobbyCode }) => {
        const lobby = lobbies[lobbyCode];
        if (!lobby || lobby.hostId !== socket.id || lobby.gameState !== 'waiting') return;
        if (lobby.players.length < 3) { 
            io.to(socket.id).emit('gameError', 'Need at least 3 players to start.');
            return;
        }

        const gameCards = globalCAHDeck.getPacks(lobby.settings.selectedPackIndexes);
        lobby.whiteDeck = [...gameCards.white];
        lobby.blackDeck = [...gameCards.black];
        shuffleArray(lobby.whiteDeck);
        shuffleArray(lobby.blackDeck);
        lobby.whiteDiscard = [];
        lobby.blackDiscard = [];

        lobby.players.forEach(player => {
            player.score = 0; 
            player.hand = []; 
            dealWhiteCards(lobby, player, MAX_HAND_SIZE);
            io.to(player.id).emit('handUpdate', player.hand);
        });
        
        lobby.czarId = lobby.players[0].id; 
        startNextRound(lobbyCode); 
        console.log(`Game started in lobby ${lobbyCode}`);
    });

    socket.on('submitCards', ({ lobbyCode, cardIds }) => {
        const lobby = lobbies[lobbyCode];
        const player = getLobbyPlayer(lobby, socket.id);

        if (!lobby || !player || lobby.gameState !== 'playing' || player.id === lobby.czarId || player.submittedCards) return;
        
        const submittedCardsObjects = [];
        const pickCount = lobby.currentBlackCard.pick || 1;

        if (!Array.isArray(cardIds) || cardIds.length !== pickCount) {
            io.to(socket.id).emit('gameError', `Invalid submission. This card requires ${pickCount} card(s).`);
            return;
        }
        
        for (const cardId of cardIds) {
            const cardIndex = player.hand.findIndex(c => c.id === cardId);
            if (cardIndex === -1) {
                io.to(socket.id).emit('gameError', 'Invalid card submitted.');
                return; 
            }
            submittedCardsObjects.push(player.hand[cardIndex]);
        }

        player.submittedCards = submittedCardsObjects;
        player.hand = player.hand.filter(card => !cardIds.includes(card.id));
        io.to(socket.id).emit('handUpdate', player.hand);

        lobby.roundSubmissions.push({ playerId: player.id, playerName: player.name, cards: submittedCardsObjects });
        
        broadcastLobbyState(lobbyCode); 

        const nonCzars = lobby.players.filter(p => p.id !== lobby.czarId);
        if (lobby.roundSubmissions.length === nonCzars.length) {
            lobby.gameState = 'judging';
            shuffleArray(lobby.roundSubmissions); 
            broadcastLobbyState(lobbyCode); 
        }
    });

    socket.on('selectWinner', ({ lobbyCode, winningPlayerId }) => {
        const lobby = lobbies[lobbyCode];
        const czar = getLobbyPlayer(lobby, socket.id);

        if (!lobby || !czar || lobby.gameState !== 'judging' || czar.id !== lobby.czarId) return;

        const winningSubmission = lobby.roundSubmissions.find(sub => sub.playerId === winningPlayerId);
        if (!winningSubmission) return;

        const winner = getLobbyPlayer(lobby, winningPlayerId);
        winner.score++;
        lobby.roundWinnerInfo = {
            winnerName: winner.name,
            winningCardsText: winningSubmission.cards.map(c => c.text),
            blackCardText: lobby.currentBlackCard.text
        };
        
        lobby.roundSubmissions.forEach(sub => {
            lobby.whiteDiscard.push(...sub.cards);
        });

        if (winner.score >= lobby.settings.scoreToWin) {
            lobby.gameState = 'gameOver';
            io.to(lobbyCode).emit('gameOver', { winnerName: winner.name, players: lobby.players });
            broadcastLobbyState(lobbyCode);
        } else {
            lobby.gameState = 'roundOver';
            broadcastLobbyState(lobbyCode);
            setTimeout(() => {
                if (lobbies[lobbyCode] && lobbies[lobbyCode].gameState === 'roundOver' && lobbies[lobbyCode].gameState !== 'gameOver') { 
                    startNextRound(lobbyCode);
                }
            }, 5000); 
        }
    });
    
    socket.on('requestNextRound', ({ lobbyCode }) => {
        const lobby = lobbies[lobbyCode];
        if (lobby && (lobby.hostId === socket.id || lobby.gameState === 'roundOver') && lobby.gameState !== 'gameOver') {
            startNextRound(lobbyCode);
        }
    });


    socket.on('disconnect', () => {
        console.log('User disconnected:', socket.id);
        for (const lobbyCode in lobbies) {
            const lobby = lobbies[lobbyCode];
            const playerIndex = lobby.players.findIndex(p => p.id === socket.id);
            if (playerIndex !== -1) {
                const disconnectedPlayerName = lobby.players[playerIndex].name;
                lobby.players.splice(playerIndex, 1);
                console.log(`${disconnectedPlayerName} left lobby ${lobbyCode}`);

                if (lobby.players.length === 0) {
                    console.log(`Lobby ${lobbyCode} is empty, deleting.`);
                    delete lobbies[lobbyCode];
                } else {
                    if (lobby.hostId === socket.id) {
                        lobby.hostId = lobby.players[0].id;
                        console.log(`New host for ${lobbyCode} is ${lobby.players[0].name}`);
                    }
                    if (lobby.gameState !== 'waiting' && lobby.gameState !== 'gameOver') {
                        if (lobby.czarId === socket.id) {
                            io.to(lobbyCode).emit('gameMessage', `${disconnectedPlayerName} (Czar) disconnected. Starting new round.`);
                            startNextRound(lobbyCode); 
                        } else if (lobby.players.length < 3 && lobby.gameState !== 'waiting') {
                            lobby.gameState = 'gameOver';
                             io.to(lobbyCode).emit('gameOver', { message: "Not enough players to continue.", players: lobby.players });
                        }
                    }
                    broadcastLobbyState(lobbyCode);
                }
                break;
            }
        }
    });
});

app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

async function loadConfig() {
    try {
        const configPath = path.join(__dirname, 'config.json');
        const configFile = await fs.readFile(configPath, 'utf-8');
        const loadedConfig = JSON.parse(configFile);
        config = { ...config, ...loadedConfig }; 
        console.log("Configuration loaded:", config);
    } catch (error) {
        if (error.code === 'ENOENT') {
            console.warn("config.json not found, creating with default values.");
            await fs.writeFile(path.join(__dirname, 'config.json'), JSON.stringify(config, null, 2));
        } else {
            console.error("Error loading config.json, using default values:", error);
        }
    }
}

async function main() {
    try {
        await loadConfig(); // Load config first

        globalCAHDeck = await CAHDeck.fromCompact(path.join(__dirname, 'cards.json'));
        console.log("Card deck loaded successfully.");
        const packs = globalCAHDeck.listPacks();
        if (!packs || packs.length === 0) {
            console.error("No packs found in cards.json or deck not loaded correctly! Please check cards.json structure.");
        } else {
            console.log(`Found ${packs.length} pack(s).`);
        }

        server.listen(PORT, () => {
            console.log(`Server listening on port ${PORT}`);
            console.log(`Access game at http://localhost:${PORT}`);
        });

    } catch (error) {
        console.error("Failed to initialize server:", error);
        process.exit(1);
    }
}

main();