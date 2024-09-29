// Carica le variabili d'ambiente
const { Client, GatewayIntentBits, SlashCommandBuilder, Routes } = require('discord.js');
const { REST } = require('@discordjs/rest');
const { joinVoiceChannel, createAudioPlayer, createAudioResource, AudioPlayerStatus } = require('@discordjs/voice');
const fs = require('fs');
require('dotenv').config();
const youtubedl = require('youtube-dl-exec');
const { google } = require('googleapis');

// Sostituisci con la tua API Key
const API_KEY = process.env.API_KEY;

const youtube = google.youtube({
    version: 'v3',
    auth: API_KEY
});

async function searchYouTube(query) {
    try {
        let videoUrl;
        let video;
        let videoId;
        let videoExt = 'mp3'; // Estensione del file audio
        let videoTitle;

        if (query.includes("&list"))
            return null;

        if (query.startsWith("https")) {
            videoUrl = query;
            // Estrai l'ID del video dall'URL
            const urlObj = new URL(videoUrl);
            videoId = urlObj.searchParams.get("v");

            // Ottieni i dettagli del video per ottenere il titolo
            const response = await youtube.videos.list({
                part: 'snippet',
                id: videoId,
            });

            video = response.data.items[0];
            if (video) {
                videoTitle = video.snippet.title;
            } else {
                console.log('Non è stato possibile ottenere i dettagli del video.');
                return null;
            }
        } else {
            const response = await youtube.search.list({
                part: 'snippet',
                q: query,
                maxResults: 1,
                type: 'video',
                order: 'relevance'
            });

            video = response.data.items[0];

            if (video) {
                videoId = video.id.videoId;
                videoTitle = video.snippet.title;
                videoUrl = `https://www.youtube.com/watch?v=${videoId}`;
                console.log(`Il primo video trovato è: ${videoUrl}`);
            } else {
                console.log('Nessun video trovato per la query specificata.');
                return null;
            }
        }

        // Costruisci il nome del file usando l'ID del video
        const filename = `./songs/${videoId}.${videoExt}`;

        // Scarica il video
        await youtubedl(videoUrl, {
            noCheckCertificates: true,
            noWarnings: true,
            format: 'bestaudio[abr<=128]',
            extractAudio: true,
            audioFormat: videoExt,
            output: filename,
            addHeader: ['referer:youtube.com', 'user-agent:googlebot'],
            concurrentFragments: 5,
        });

        console.log('Download completato!');
        return { filename, title: videoTitle };

    } catch (error) {
        console.error('Errore durante la ricerca su YouTube:', error);
        return null;
    }
}

// Mappe per memorizzare le connessioni vocali e i player audio per ogni guild
const voiceConnections = new Map();
const audioPlayers = new Map();
const songQueues = new Map(); // Mappa per le code delle canzoni

const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates],
});

// Token del bot
const token = process.env.TOKEN;
const clientId = process.env.CLIENT; // ID client del tuo bot (ID dell'applicazione)

// Registrazione dei comandi slash globali
const rest = new REST({ version: '10' }).setToken(token);
const commands = [
    new SlashCommandBuilder()
        .setName('musica')
        .setDescription('LEONETTI BOSS(etti)')
        .addStringOption(option =>
            option.setName('song')
                .setDescription('Inserisci il nome o il link della canzone')
                .setRequired(true)
        ),
    new SlashCommandBuilder()
        .setName('ammazzati')
        .setDescription('Addio Leonetti'),
    new SlashCommandBuilder()
        .setName('skip')
        .setDescription('Salta la canzone corrente e riproduci la prossima'),
    new SlashCommandBuilder()
        .setName('guarda')
        .setDescription('Guarda le canzoni attualmente nella coda'),
    new SlashCommandBuilder()
        .setName('vai')
        .setDescription('Vai a una canzone specifica nella coda')
        .addIntegerOption(option =>
            option.setName('numero')
                .setDescription('Numero della canzone nella coda')
                .setRequired(true)
        ),
].map(command => command.toJSON());

// Registra i comandi a livello globale
(async () => {
    try {
        console.log('Inizio registrazione dei comandi slash globali.');

        await rest.put(
            Routes.applicationCommands(clientId),  // Registrazione globale dei comandi
            { body: commands }
        );

        console.log('Comandi slash globali registrati con successo.');
    } catch (error) {
        console.error(error);
    }
})();

// Funzione per gestire la coda e riprodurre le canzoni
function playQueue(guildId) {
    const queue = songQueues.get(guildId);
    if (!queue || queue.length === 0) {
        // Non ci sono più canzoni nella coda
        songQueues.delete(guildId);

        // Distruggi la connessione vocale se esiste
        const connection = voiceConnections.get(guildId);
        if (connection) {
            connection.destroy();
            voiceConnections.delete(guildId);
        }

        // Rimuovi il player audio
        audioPlayers.delete(guildId);

        return;
    }

    const song = queue.shift();

    const voiceChannel = song.voiceChannel;
    const interaction = song.interaction;

    const connection = joinVoiceChannel({
        channelId: voiceChannel.id,
        guildId: voiceChannel.guild.id,
        adapterCreator: voiceChannel.guild.voiceAdapterCreator,
    });

    voiceConnections.set(guildId, connection);

    const player = createAudioPlayer();

    audioPlayers.set(guildId, player);

    player.on('stateChange', (oldState, newState) => {
        console.log(`Player audio cambiato da ${oldState.status} a ${newState.status}`);
    });

    player.on('error', error => {
        console.error('Errore nel player audio:', error);

        // Elimina il file audio dopo un errore
        fs.unlink(song.filename, (err) => {
            if (err) console.error('Errore durante l\'eliminazione del file:', err);
            else console.log('File audio eliminato:', song.filename);
        });

        // Riproduci la prossima canzone nella coda
        playQueue(guildId);
    });

    player.on(AudioPlayerStatus.Idle, () => {
        // Elimina il file audio dopo la riproduzione
        fs.unlink(song.filename, (err) => {
            if (err) console.error('Errore durante l\'eliminazione del file:', err);
            else console.log('File audio eliminato:', song.filename);
        });

        // Riproduci la prossima canzone nella coda
        playQueue(guildId);
    });

    console.log('Creazione della risorsa audio con il file:', song.filename);
    const resource = createAudioResource(song.filename);

    // Riproduci la risorsa
    player.play(resource);

    // Sottoscrivi il player alla connessione
    connection.subscribe(player);

    // Informa l'utente che la canzone sta suonando
    song.interaction.followUp(`La coppola family sta suonando: \`${song.title}\``);
}

// Gestisci i comandi slash
client.on('interactionCreate', async interaction => {
    if (!interaction.isCommand()) return;

    const { commandName } = interaction;

    if (commandName === 'musica') {
        // Ottieni il nome della canzone dall'input dell'utente
        const songName = interaction.options.getString('song');

        // Verifica se l'utente è in un canale vocale
        const voiceChannel = interaction.member.voice.channel;

        if (!voiceChannel) {
            await interaction.reply('Fottiti');
            return;
        }

        // Deferisci l'interazione per evitare che scada
        await interaction.deferReply();

        // Cerca la canzone su YouTube e ottieni le informazioni
        const songInfo = await searchYouTube(songName);

        if (!songInfo) {
            await interaction.editReply("Non l'aggio trovata");
            return;
        }

        // Ottieni o crea la coda per la guild
        let queue = songQueues.get(interaction.guild.id);

        if (!queue) {
            queue = [];
            songQueues.set(interaction.guild.id, queue);
        }

        // Aggiungi la canzone alla coda
        queue.push({
            title: songInfo.title,
            filename: songInfo.filename,
            requestedBy: interaction.user.username,
            voiceChannel: voiceChannel,
            interaction: interaction
        });

        // Informa l'utente che la canzone è stata aggiunta alla coda
        await interaction.editReply(`La canzone \`${songInfo.title}\` è stata aggiunta alla coda da ${interaction.user.username}.`);

        // Se il bot non sta già suonando, inizia a suonare
        if (!audioPlayers.has(interaction.guild.id)) {
            playQueue(interaction.guild.id);
        }

    } else if (commandName === 'ammazzati') {
        // Gestisci il comando 'ammazzati'
        const connection = voiceConnections.get(interaction.guild.id);
        const player = audioPlayers.get(interaction.guild.id);
        const queue = songQueues.get(interaction.guild.id);

        if (!connection || !player || !queue) {
            await interaction.reply('NO');
            return;
        }

        // Elimina tutti i file audio nella coda
        queue.forEach(song => {
            fs.unlink(song.filename, (err) => {
                if (err) console.error('Errore durante l\'eliminazione del file:', err);
                else console.log('File audio eliminato:', song.filename);
            });
        });

        // Ferma il player e distruggi la connessione
        player.stop();
        connection.destroy();

        // Rimuovi la connessione, il player e la coda dalle mappe
        voiceConnections.delete(interaction.guild.id);
        audioPlayers.delete(interaction.guild.id);
        songQueues.delete(interaction.guild.id);

        await interaction.reply('Passa la mia coppola alla generazioni future. Tutte le canzoni sono state eliminate.');

    } else if (commandName === 'skip') {
        // Gestisci il comando 'skip'
        const player = audioPlayers.get(interaction.guild.id);
        const queue = songQueues.get(interaction.guild.id);

        if (!player || !queue || queue.length === 0) {
            await interaction.reply('Cazzo skippo.');
            return;
        }

        // Ottieni la canzone corrente dalla coda (la prima in lista)
        const currentSong = queue[0];

        // Elimina il file audio
        fs.unlink(currentSong.filename, (err) => {
            if (err) console.error('Errore durante l\'eliminazione del file:', err);
            else console.log('File audio eliminato:', currentSong.filename);
        });

        // Ferma il player per passare alla prossima canzone
        player.stop();

        await interaction.reply('Tolta sta merda.');

    } else if (commandName === 'guarda') {
        const queue = songQueues.get(interaction.guild.id);

        if (!queue || queue.length === 0) {
            await interaction.reply('La coda è vuota.');
            return;
        }

        // Crea una lista delle canzoni presenti nella coda
        const queueList = queue.map((song, index) => `${index + 1}. ${song.title} (richiesta da: ${song.requestedBy})`).join('\n');

        await interaction.reply(`Canzoni attualmente in coda:\n${queueList}`);

    } else if (commandName === 'vai') {
        const songNumber = interaction.options.getInteger('numero');
        const queue = songQueues.get(interaction.guild.id);

        if (!queue || queue.length === 0) {
            await interaction.reply('La coda è vuota.');
            return;
        }

        if (songNumber < 1 || songNumber > queue.length) {
            await interaction.reply('Numero della canzone non valido.');
            return;
        }

        // Rimuovi tutte le canzoni fino alla canzone specificata
        queue.splice(0, songNumber - 1);

        // Ferma il player corrente e passa alla canzone specifica
        const player = audioPlayers.get(interaction.guild.id);
        if (player) {
            player.stop(); // Questo forzerà l'avvio della canzone desiderata
        }

        await interaction.reply(`Salto alla canzone numero ${songNumber}: \`${queue[0].title}\`.`);
    }
});

// Accedi a Discord
client.login(token);
