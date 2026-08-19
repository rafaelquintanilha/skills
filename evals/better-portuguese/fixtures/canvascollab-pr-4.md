# [codex] Add shareable collaboration rooms

## Summary

- Add permalink board routes at `/c/:roomId`, with `/` creating a room URL for sharing.
- Add an Express-hosted WebSocket signaling endpoint for room membership and WebRTC offer/answer/ICE relay.
- Update the collaboration hook to join rooms through the signaling socket while keeping board traffic on WebRTC data channels.
- Add a Share button that copies the room permalink, with a fallback for restricted clipboard surfaces.

## Validation

- `npm run check`
- `npm run build`
- In-app Browser validation for room permalink creation and Share link copy behavior.
- WebSocket relay smoke test with two clients receiving `peers` and `peer-joined` messages.

## Notes

This first pass keeps board state ephemeral and in-memory. The signaling server does not persist board contents.
