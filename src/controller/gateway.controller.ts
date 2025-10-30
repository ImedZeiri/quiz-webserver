import {
  WebSocketGateway,
  WebSocketServer,
  OnGatewayConnection,
  OnGatewayDisconnect,
  SubscribeMessage,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { GatewayService } from '../service/gateway.service';
import type { StartQuizPayload, SubmitAnswerPayload } from 'src/types/websocket.interface';

@WebSocketGateway({
  cors: {
    origin: '*',
  },
  transports: ['websocket', 'polling'],
})
export class GatewayController
  implements OnGatewayConnection, OnGatewayDisconnect
{
  @WebSocketServer()
  server: Server;

  constructor(private readonly gatewayService: GatewayService) {}

  afterInit() {
    this.gatewayService.setServer(this.server);
  }

  handleConnection(client: Socket) {
    this.gatewayService.handleConnection(client.id);
  }

  handleDisconnect(client: Socket) {
    this.gatewayService.handleDisconnection(client.id);
  }

  @SubscribeMessage('startQuiz')
  async handleStartQuiz(client: Socket, payload: StartQuizPayload) {
    await this.gatewayService.startQuiz(client.id, payload);
  }

  @SubscribeMessage('submitAnswer')
  async handleSubmitAnswer(client: Socket, payload: SubmitAnswerPayload) {
    this.gatewayService.submitAnswer(client.id, payload);
  }

  @SubscribeMessage('joinLobby')
  async handleJoinLobby(client: Socket) {
    this.gatewayService.joinLobby(client.id);
  }

  @SubscribeMessage('authenticate')
  async handleAuthenticate(client: Socket, payload: { token: string }) {
    this.gatewayService.authenticateUser(client.id, payload.token);
  }

  @SubscribeMessage('checkEvents')
  async handleCheckEvents(client: Socket) {
    await this.gatewayService.forceEventCheck();
    client.emit('eventsChecked', {
      message: 'Vérification des événements effectuée',
      timestamp: new Date().toISOString()
    });
  }

  @SubscribeMessage('requestLobbyStatus')
  async handleRequestLobbyStatus(client: Socket) {
    // Envoyer le statut actuel du lobby au client
    if (this.gatewayService['currentLobby']) {
      const lobby = this.gatewayService['currentLobby'];
      client.emit('lobbyStatus', {
        isOpen: true,
        event: {
          id: lobby.event.id,
          theme: lobby.event.theme,
          startDate: lobby.event.startDate,
          numberOfQuestions: lobby.event.numberOfQuestions,
          minPlayers: lobby.event.minPlayers
        },
        participants: lobby.participants.size
      });
    } else {
      client.emit('lobbyStatus', {
        isOpen: false,
        event: null,
        participants: 0
      });
    }
  }
}