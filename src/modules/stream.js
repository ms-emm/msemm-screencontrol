const STREAM_ID_LENGTH = 8;
const STREAM_ID_CHARACTERS = '0123456789';

export function createNewStreamId(io) {
    let newId;
    const charactersLength = STREAM_ID_CHARACTERS.length;
    do {
        newId = '';
        for (let i = 0; i < STREAM_ID_LENGTH; i++) {
            newId += STREAM_ID_CHARACTERS.charAt(Math.floor(Math.random() * charactersLength));
        }
    } while (io.sockets.adapter.rooms.has(newId));

    return newId;
}

export function isStreamIdValid(streamId) {
    return typeof streamId === 'string' && /^\d+$/.test(streamId) && streamId.length === STREAM_ID_LENGTH
}

export function getStreamId(socket) {
    return Array.from(socket.rooms).find(room => room != socket.id);
}

export async function getHostSocket(io, streamId) {
    const socketsInStream = await io.in(streamId).fetchSockets();
    return socketsInStream.find(item => item.data && item.data.isHost === true);
}