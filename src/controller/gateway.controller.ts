import {
  WebSocketGateway,
  WebSocketServer,
  OnGatewayConnection,
  OnGatewayDisconnect,
  SubscribeMessage,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { GatewayService } from '../service/gateway.service';
import type { StartQuizPayload, SubmitAnswerPayload, StartSoloQuizPayload, SetContextPayload } from 'src/types/websocket.interface';

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
    console.log(`🔌 Nouvelle connexion WebSocket: ${client.id}`);
    this.gatewayService.handleConnection(client.id);
    
    // Envoyer immédiatement un événement de confirmation de connexion
    client.emit('connectionEstablished', {
      socketId: client.id,
      timestamp: new Date().toISOString(),
      message: 'Connexion WebSocket établie avec succès'
    });
  }

  handleDisconnect(client: Socket) {
    this.gatewayService.handleDisconnection(client.id);
  }

  // Handler startQuiz supprimé - les utilisateurs ne peuvent plus créer de quiz manuellement

  @SubscribeMessage('submitAnswer')
  async handleSubmitAnswer(client: Socket, payload: SubmitAnswerPayload) {
    this.gatewayService.submitAnswer(client.id, payload);
  }

  @SubscribeMessage('joinLobby')
  async handleJoinLobby(client: Socket) {
    const userSession = this.gatewayService.getUserSession(client.id);
    if (!userSession?.isAuthenticated) {
      client.emit('error', {
        message: 'Authentification requise pour rejoindre le lobby',
        code: 'AUTH_REQUIRED_FOR_ONLINE',
        requiredAction: 'LOGIN'
      });
      return;
    }
    
    this.gatewayService.joinLobby(client.id);
  }

  @SubscribeMessage('authenticate')
  async handleAuthenticate(client: Socket, payload: { token: string }) {
    if (!payload?.token) {
      client.emit('error', {
        message: 'Token manquant pour l\'authentification',
        code: 'MISSING_TOKEN'
      });
      return;
    }
    
    console.log(`🔐 Tentative d'authentification pour ${client.id}`);
    this.gatewayService.authenticateUser(client.id, payload.token);
  }

  @SubscribeMessage('startSoloQuiz')
  async handleStartSoloQuiz(client: Socket, payload: StartSoloQuizPayload) {
    console.log(`🎯 Demande de quiz solo de ${client.id}:`, payload);
    await this.gatewayService.startSoloQuiz(client.id, payload);
  }

  @SubscribeMessage('leaveLobby')
  async handleLeaveLobby(client: Socket) {
    this.gatewayService.leaveLobby(client.id);
  }

  @SubscribeMessage('joinInProgress')
  async handleJoinInProgress(client: Socket) {
    const userSession = this.gatewayService.getUserSession(client.id);
    if (!userSession?.isAuthenticated) {
      client.emit('error', {
        message: 'Authentification requise pour rejoindre un événement en cours',
        code: 'AUTH_REQUIRED_FOR_ONLINE',
        requiredAction: 'LOGIN'
      });
      return;
    }
    
    this.gatewayService.joinOngoingEvent(client.id);
  }

  @SubscribeMessage('checkEvents')
  async handleCheckEvents(client: Socket) {
    await this.gatewayService.forceEventCheck();
    client.emit('eventsChecked', {
      message: 'Vérification des événements effectuée',
      timestamp: new Date().toISOString()
    });
  }



  @SubscribeMessage('setContext')
  async handleSetContext(client: Socket, payload: { mode: string; isSolo?: boolean; isInLobby?: boolean; isInQuiz?: boolean }) {
    // Validation du payload
    if (!payload || !payload.mode) {
      client.emit('error', { 
        message: 'Mode requis pour définir le contexte',
        code: 'INVALID_CONTEXT_PAYLOAD'
      });
      return;
    }

    // Validation des modes autorisés
    const allowedModes = ['home', 'solo', 'online', 'quiz'];
    if (!allowedModes.includes(payload.mode)) {
      client.emit('error', { 
        message: `Mode non autorisé: ${payload.mode}. Modes autorisés: ${allowedModes.join(', ')}`,
        code: 'INVALID_MODE'
      });
      return;
    }

    // Validation spéciale pour les modes nécessitant une authentification
    if ((payload.mode === 'online' || (payload.mode === 'quiz' && !payload.isSolo))) {
      const userSession = this.gatewayService.getUserSession(client.id);
      if (!userSession?.isAuthenticated) {
        client.emit('error', {
          message: `Le mode ${payload.mode} nécessite une authentification. Veuillez vous connecter d'abord.`,
          code: payload.mode === 'online' ? 'AUTH_REQUIRED_FOR_ONLINE' : 'AUTH_REQUIRED_FOR_MULTIPLAYER',
          requiredAction: 'LOGIN'
        });
        return;
      }
    }

    console.log(`📍 Demande de contexte reçue de ${client.id}: ${payload.mode}`, payload);
    this.gatewayService.setUserContext(client.id, payload);
  }

  @SubscribeMessage('debugContext')
  async handleDebugContext(client: Socket, payload?: { clientId?: string }) {
    if (payload?.clientId) {
      this.gatewayService.debugClientSubscriptions(payload.clientId);
    } else {
      this.gatewayService.debugUserContexts();
    }
    
    const summary = this.gatewayService.getContextSummary();
    client.emit('debugContextResult', {
      summary,
      timestamp: new Date().toISOString()
    });
  }

  @SubscribeMessage('testEventBroadcast')
  async handleTestEventBroadcast(client: Socket, payload: { eventName: string; testData?: any }) {
    if (!payload?.eventName) {
      client.emit('error', { message: 'eventName requis pour le test' });
      return;
    }
    
    this.gatewayService.debugEventBroadcast(payload.eventName, payload.testData);
    client.emit('testEventBroadcastResult', {
      eventName: payload.eventName,
      message: 'Test de diffusion effectué, vérifiez les logs serveur',
      timestamp: new Date().toISOString()
    });
  }
}