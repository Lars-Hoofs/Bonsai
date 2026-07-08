import { OnEvent } from '@nestjs/event-emitter';
import {
  ConnectedSocket,
  MessageBody,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';

export interface ChatMessageEvent {
  conversationId: string;
  role: string;
  content: string;
}

export const CHAT_MESSAGE_EVENT = 'chat.message';

/**
 * Real-time delivery for live handover / streaming chat. Clients connect to the
 * `/chat` namespace and `join` a conversation room; every persisted message
 * (visitor, bot, agent, system) is broadcast to that room. Note: handshake
 * auth (agent JWT / public widget key) is a documented follow-up — rooms are
 * keyed by an unguessable conversation UUID in the meantime.
 */
@WebSocketGateway({ namespace: 'chat', cors: { origin: '*' } })
export class ChatGateway {
  @WebSocketServer() server!: Server;

  @SubscribeMessage('join')
  join(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { conversationId: string },
  ): { joined: string } {
    void client.join(`conv:${data.conversationId}`);
    return { joined: data.conversationId };
  }

  @OnEvent(CHAT_MESSAGE_EVENT)
  broadcast(event: ChatMessageEvent): void {
    this.server?.to(`conv:${event.conversationId}`).emit('message', event);
  }
}
