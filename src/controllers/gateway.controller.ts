import {
  WebSocketGateway,
  WebSocketServer,
  OnGatewayConnection,
  OnGatewayDisconnect,
  SubscribeMessage,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { GatewayService } from '../services/gateway.service';

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
  async handleStartQuiz(client: Socket, payload: { theme?: string; limit?: number; timeLimit?: number }) {
    await this.gatewayService.startQuiz(client.id, payload);
  }

  @SubscribeMessage('submitAnswer')
  async handleSubmitAnswer(client: Socket, payload: { questionId: number; answer: number }) {
    this.gatewayService.submitAnswer(client.id, payload);
  }
}
