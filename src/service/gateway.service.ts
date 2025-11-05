import { Injectable } from '@nestjs/common';
import { Server, Socket } from 'socket.io';
import { QuestionService } from './question.service';
import { EventService } from './event.service';
import { UsersService } from './users.service';
import { Question } from '../model/question.entity';
import { Event } from '../model/event.entity';
import type {
  QuizSession,
  GlobalQuiz,
  EventLobby,
  QuizParticipant,
  StartQuizPayload,
  SubmitAnswerPayload,
  PlayerStats
} from '../types';

interface UserSession {
  socketId: string;
  token: string;
  userId?: string;
  isConnected: boolean;
  isParticipating: boolean;
  participationMode?: 'play' | 'watch';
  isAuthenticated: boolean;
  userType: 'authenticated' | 'guest';
  connectedAt: Date;
}

@Injectable()
export class GatewayService {
  private quizSessions = new Map<string, QuizSession>();
  private globalQuiz: GlobalQuiz | null = null;
  private eventCheckInterval?: NodeJS.Timeout;
  private server: Server;
  private currentLobby: EventLobby | null = null;
  private nextEventTimer?: NodeJS.Timeout;
  private userSessions = new Map<string, UserSession>();

  constructor(
    private readonly questionService: QuestionService,
    private readonly eventService: EventService,
    private readonly usersService: UsersService,
  ) {
    this.initializeNextEvent();
    this.startEventScheduler();
    setTimeout(() => this.checkAndOpenLobbyIfNeeded(), 1000);
    setInterval(() => this.debugEventStatus(), 30000);
    setInterval(() => this.emergencyLobbyCheck(), 60000);
  }

  setServer(server: Server) {
    this.server = server;
  }

  async handleEventUpdated(updatedEvent: Event) {
    // Always broadcast the updated next-event info
    this.broadcastNextEvent(updatedEvent);

    // If there is an open lobby for this event, update it in place
    if (this.currentLobby && this.currentLobby.event.id === updatedEvent.id) {
      // Update event details in the current lobby
      this.currentLobby.event = updatedEvent;

      // Restart countdown with the new startDate
      if (this.currentLobby.countdownTimer) {
        clearInterval(this.currentLobby.countdownTimer);
        this.currentLobby.countdownTimer = undefined;
      }
      this.startEventCountdown();

      // Re-send lobby info so clients refresh details
      this.server.emit('lobbyOpened', {
        event: {
          id: updatedEvent.id,
          theme: updatedEvent.theme || 'Questions Aléatoires',
          numberOfQuestions: updatedEvent.numberOfQuestions,
          startDate: updatedEvent.startDate,
          minPlayers: updatedEvent.minPlayers,
        },
      });

      // Send immediate countdown snapshot
      const now = new Date().getTime();
      const eventTime = new Date(updatedEvent.startDate).getTime();
      const timeLeft = Math.max(0, Math.floor((eventTime - now) / 1000));
      this.server.emit('eventCountdown', {
        timeLeft,
        participants: this.currentLobby.participants.size,
        minPlayers: updatedEvent.minPlayers,
      });
    }

    // Also emit a generic update event for any client-side custom handlers
    this.server.emit('eventUpdated', {
      id: updatedEvent.id,
      theme: updatedEvent.theme,
      startDate: updatedEvent.startDate,
      numberOfQuestions: updatedEvent.numberOfQuestions,
      minPlayers: updatedEvent.minPlayers,
    });
  }

  // --- Méthodes utilitaires ---
  private isGlobalQuizActive(): boolean {
    return this.globalQuiz?.isActive === true;
  }

  // --- Logique principale inchangée ---
  async getQuestionsByTheme(theme?: string, limit: number = 10): Promise<Question[]> {
    console.log(`getQuestionsByTheme - Thème: ${theme}, Limite: ${limit}`);
    
    if (theme && theme.trim() !== '') {
      const themeQuestions = await this.questionService.findByTheme(theme);
      console.log(`Questions trouvées pour le thème '${theme}': ${themeQuestions.length}`);
      
      if (themeQuestions.length > 0) {
        const result = themeQuestions.slice(0, limit);
        console.log(`Questions retournées après slice: ${result.length}`);
        return result;
      }
    }
    
    console.log(`Retour de questions aléatoires avec limite: ${limit}`);
    const randomQuestions = await this.questionService.findRandomQuestions(limit);
    console.log(`Questions aléatoires récupérées: ${randomQuestions.length}`);
    return randomQuestions;
  }

  handleConnection(clientId: string) {
  console.log(`Client connected: ${clientId}`);
  
  this.userSessions.set(clientId, {
    socketId: clientId,
    token: '',
    isConnected: true,
    isParticipating: false,
    isAuthenticated: false,
    userType: 'guest',
    connectedAt: new Date()
  });
  
  this.checkAndOpenLobbyIfNeeded();
  this.sendNextEventInfo(clientId);
  
  if (this.currentLobby) {
    this.sendLobbyInfo(clientId);
    this.sendEventCountdown(clientId);
  }
  this.broadcastPlayerStats();
  this.broadcastUserStats(); // ADD THIS
}

handleDisconnection(clientId: string) {
  console.log(`Client disconnected: ${clientId}`);
  
  this.userSessions.delete(clientId);
  
  const session = this.quizSessions.get(clientId);
  if (session?.timer) clearTimeout(session.timer);
  if (session?.timerInterval) clearInterval(session.timerInterval);
  this.quizSessions.delete(clientId);
  if (this.globalQuiz?.participants) {
    this.globalQuiz.participants.delete(clientId);
  }
  
  if (this.currentLobby?.participants.has(clientId)) {
    this.currentLobby.participants.delete(clientId);
    console.log(`Joueur ${clientId} retiré du lobby. Total: ${this.currentLobby.participants.size}`);
    this.broadcastLobbyUpdate();
  }
  this.broadcastPlayerStats();
  this.broadcastUserStats();
}

  async startSoloQuiz(clientId: string, payload: { theme?: string }) {
    try {
      const { theme } = payload || {};
      const client = this.server.sockets.sockets.get(clientId);
      const questions = await this.getQuestionsByTheme(theme, 10);

      if (questions.length === 0) {
        client?.emit('error', { message: 'Aucune question trouvée pour ce thème' });
        return;
      }

      const soloQuestions = questions.map(q => ({
        id: q.id,
        theme: q.theme,
        questionText: q.questionText,
        response1: q.response1,
        response2: q.response2,
        response3: q.response3,
        response4: q.response4,
        correctResponse: q.correctResponse,
      }));

      client?.emit('soloQuestions', { questions: soloQuestions });
      console.log(`Mode solo démarré pour ${clientId} avec ${questions.length} questions (thème: ${theme || 'aléatoire'})`);
    } catch (error) {
      console.error('Erreur lors du démarrage du quiz solo:', error);
      const client = this.server.sockets.sockets.get(clientId);
      client?.emit('error', { message: 'Erreur lors du démarrage du quiz solo. Veuillez réessayer.' });
    }
  }

  async startQuiz(clientId: string, payload: StartQuizPayload) {
    // ❌ Cette méthode n'est plus utilisée — les quiz multijoueurs sont lancés uniquement via événements
    const client = this.server.sockets.sockets.get(clientId);
    client?.emit('error', { message: 'Le quiz multijoueur ne peut être lancé manuellement' });
  }

  submitAnswer(clientId: string, payload: SubmitAnswerPayload) {
    const session = this.quizSessions.get(clientId);
    const client = this.server.sockets.sockets.get(clientId);

    if (!session) {
      client?.emit('error', { message: 'Aucune session de quiz active' });
      return;
    }

    if (session.isWatching) {
      client?.emit('error', { message: 'Vous êtes en mode surveillance - réponses bloquées' });
      return;
    }

    const currentQuestion = session.questions[session.currentIndex];
    if (currentQuestion.id !== payload.questionId) {
      client?.emit('error', { message: 'Question invalide' });
      return;
    }

    if (session.timeLeft <= 0) {
      client?.emit('error', { message: 'Temps expiré - réponse non acceptée' });
      return;
    }

    // Vérifier si c'est la dernière question
    const isFinalQuestion = this.globalQuiz && this.globalQuiz.currentQuestionIndex === this.globalQuiz.questions.length - 1;
    
    if (isFinalQuestion) {
      // Pour la dernière question, vérifier immédiatement si la réponse est correcte
      const isCorrect = currentQuestion.correctResponse === payload.answer;
      if (isCorrect) {
        // Première réponse correcte sur la dernière question - fermer l'événement immédiatement
        this.handleFinalQuestionCorrectAnswer(clientId, payload);
        return;
      }
    }

    session.pendingAnswer = { questionId: payload.questionId, answer: payload.answer };
    client?.emit('answerQueued', { questionId: payload.questionId, answer: payload.answer, timeLeft: session.timeLeft });
    this.broadcastPlayerStats();
  }

  // --- Gestion du quiz global ---
  private startGlobalQuiz() {
    if (!this.globalQuiz) return;

    setTimeout(() => {
      this.broadcastCurrentQuestion();

      this.globalQuiz!.timerInterval = setInterval(() => {
        if (!this.globalQuiz) return;
        this.globalQuiz.timeLeft--;
        this.server.emit('timerUpdate', { timeLeft: this.globalQuiz.timeLeft, ...this.getPlayerStats() });

        if (this.globalQuiz.timeLeft <= 0) {
          this.handleGlobalTimeExpired();
        }
      }, 1000);

      this.globalQuiz!.timer = setTimeout(() => {
        this.handleGlobalTimeExpired();
      }, this.globalQuiz!.timeLimit * 1000);
    }, 1000);
  }

  private broadcastCurrentQuestion() {
    if (!this.globalQuiz) return;

    this.quizSessions.forEach((session, clientId) => {
      const client = this.server.sockets.sockets.get(clientId);
      if (client) {
        session.currentIndex = this.globalQuiz!.currentQuestionIndex;
        session.timeLeft = this.globalQuiz!.timeLeft;
        session.pendingAnswer = undefined;
        this.sendCurrentQuestion(client, session);
      }
    });
  }

  private sendCurrentQuestion(client: Socket, session: QuizSession) {
    const currentQuestion = session.questions[session.currentIndex];
    client.emit('quizQuestion', {
      question: {
        id: currentQuestion.id,
        theme: currentQuestion.theme,
        questionText: currentQuestion.questionText,
        response1: currentQuestion.response1,
        response2: currentQuestion.response2,
        response3: currentQuestion.response3,
        response4: currentQuestion.response4,
      },
      questionNumber: session.currentIndex + 1,
      totalQuestions: session.questions.length,
      previousAnswer: session.answers.length > 0 ? session.answers[session.answers.length - 1] : null,
      isWatching: session.isWatching,
      timeLeft: session.timeLeft,
      ...this.getPlayerStats(),
    });
  }

 private handleGlobalTimeExpired() {
  if (!this.globalQuiz) return;

  if (this.globalQuiz.timerInterval) clearInterval(this.globalQuiz.timerInterval);
  if (this.globalQuiz.timer) clearTimeout(this.globalQuiz.timer);

  this.quizSessions.forEach((session, clientId) => {
    if (session.currentIndex === this.globalQuiz!.currentQuestionIndex) {
      const currentQuestion = session.questions[session.currentIndex];
      let userAnswer = 0;
      let isCorrect = false;

      if (!session.isWatching && session.pendingAnswer && session.pendingAnswer.questionId === currentQuestion.id) {
        userAnswer = session.pendingAnswer.answer;
        isCorrect = currentQuestion.correctResponse === userAnswer;
        if (isCorrect) {
          session.score++;
          const participant = this.globalQuiz!.participants?.get(clientId);
          if (participant) {
            participant.score = session.score;
            if (this.globalQuiz!.currentQuestionIndex === this.globalQuiz!.questions.length - 1) {
              participant.finishedAt = new Date();
            }
          }
        } else {
          // USER NOW GOES TO WATCH MODE - UPDATE THEIR PARTICIPATION
          session.isWatching = true;
          this.updateUserParticipation(clientId, true, 'watch');
        }
      } else if (!session.isWatching) {
        // USER DIDN'T ANSWER - GO TO WATCH MODE
        session.isWatching = true;
        this.updateUserParticipation(clientId, true, 'watch');
      }

      const submittedAt = Date.now();
      const answerData = {
        questionId: currentQuestion.id,
        userAnswer,
        correct: isCorrect,
        submittedAt,
      };
      
      session.answers.push(answerData);
      const participant = this.globalQuiz!.participants?.get(clientId);
      if (participant) {
        participant.answers.push(answerData);
        if (isCorrect) {
          participant.lastCorrectAnswerTime = submittedAt;
        } else {
          participant.lastCorrectAnswerTime = undefined;
        }
      }
      session.pendingAnswer = undefined;
    }
  });

  this.globalQuiz.currentQuestionIndex++;

  if (this.globalQuiz.currentQuestionIndex >= this.globalQuiz.questions.length) {
    this.completeGlobalQuiz();
  } else {
    // Vérifier si c'est l'avant-dernière question (donc la prochaine sera la dernière)
    const isNextQuestionFinal = this.globalQuiz.currentQuestionIndex === this.globalQuiz.questions.length - 1;
    
    if (isNextQuestionFinal) {
      // Afficher la publicité pendant 15s avant la dernière question
      this.startAdBreakBeforeFinalQuestion();
    } else {
      this.globalQuiz.timeLeft = this.globalQuiz.timeLimit;
      this.startGlobalQuiz();
    }
  }
  
  // BROADCAST UPDATED USER STATS AFTER MODE CHANGES
  this.broadcastUserStats();
}

  private async completeGlobalQuiz() {
    if (!this.globalQuiz) return;

    if (this.globalQuiz.timerInterval) clearInterval(this.globalQuiz.timerInterval);
    if (this.globalQuiz.timer) clearTimeout(this.globalQuiz.timer);

    let winnerSessionId: string | null = null;
    let winnerUsername: string | null = null;
    let winnerPhone: string | null = null;
    
    if (this.globalQuiz.event && this.globalQuiz.participants.size > 0) {
      const participants = Array.from(this.globalQuiz.participants.values())
        .filter(p => p.lastCorrectAnswerTime)
        .sort((a, b) => a.lastCorrectAnswerTime! - b.lastCorrectAnswerTime!);

      if (participants.length > 0) {
        winnerSessionId = participants[0].clientId;
        const winnerInfo = await this.getWinnerInfo(winnerSessionId);
        winnerUsername = winnerInfo.username || null;
        winnerPhone = winnerInfo.phoneNumber || null;
        
        if (winnerPhone) {
          await this.eventService.completeEvent(this.globalQuiz.event.id, winnerPhone);
        } else {
          await this.eventService.completeEvent(this.globalQuiz.event.id, winnerSessionId);
        }

        this.server.emit('eventCompleted', {
          eventId: this.globalQuiz.event.id,
          winner: winnerUsername || winnerSessionId,
          winnerPhone,
          winnerDisplay: winnerUsername ? `🏆 ${winnerUsername}` : `Session: ${winnerSessionId}`,
        });
      }
    }

    this.quizSessions.forEach((session, clientId) => {
      const client = this.server.sockets.sockets.get(clientId);
      if (client) {
        client.emit('quizCompleted', {
          score: session.score,
          totalQuestions: session.questions.length,
          answers: session.answers,
          joinedAt: session.joinedAt,
          winner: winnerUsername || winnerSessionId,
          isWinner: clientId === winnerSessionId,
        });
      }
    });

    setTimeout(() => this.server.disconnectSockets(true), 5000);

    this.globalQuiz = null;
    this.quizSessions.clear();
    // ✅ Nettoyage explicite du lobby après fin du quiz
    this.currentLobby = null;
  }

  // --- Stats ---
  private getPlayerStats(): PlayerStats {
    const activePlayers = Array.from(this.quizSessions.values()).filter(s => !s.isWatching).length;
    const watchingPlayers = Array.from(this.quizSessions.values()).filter(s => s.isWatching).length;
    return { activePlayers, watchingPlayers, totalPlayers: activePlayers + watchingPlayers };
  }

  private broadcastPlayerStats() {
    this.server.emit('playerStats', this.getPlayerStats());
  }

  // --- Authentification ---
  authenticateUser(clientId: string, token: string) {
    const userSession = this.userSessions.get(clientId);
    if (userSession) {
      userSession.token = token;
      userSession.userId = this.extractUserIdFromToken(token);
      userSession.isAuthenticated = true;
      userSession.userType = 'authenticated';
      this.broadcastUserStats();
    }
  }

  private extractUserIdFromToken(token: string): string | undefined {
    try {
      const cleanToken = token.replace('Bearer ', '');
      const payload = JSON.parse(atob(cleanToken.split('.')[1]));
      return payload.sub || payload.userId || payload.id;
    } catch (error) {
      console.warn('Impossible d\'extraire l\'ID utilisateur du token');
      return undefined;
    }
  }

  private extractUserInfoFromToken(token: string): { userId?: string; username?: string; phoneNumber?: string } {
    try {
      const cleanToken = token.replace('Bearer ', '');
      const payload = JSON.parse(atob(cleanToken.split('.')[1]));
      return {
        userId: payload.sub || payload.userId || payload.id,
        username: payload.username,
        phoneNumber: payload.phoneNumber
      };
    } catch (error) {
      console.warn('Impossible d\'extraire les informations utilisateur du token');
      return {};
    }
  }

  private async getWinnerInfo(sessionId: string): Promise<{ username?: string; phoneNumber?: string; userId?: string }> {
    const userSession = this.userSessions.get(sessionId);
    if (!userSession || !userSession.token) return {};
    return this.extractUserInfoFromToken(userSession.token);
  }

 private updateUserParticipation(clientId: string, isParticipating: boolean, mode?: 'play' | 'watch') {
  const userSession = this.userSessions.get(clientId);
  if (userSession) {
    userSession.isParticipating = isParticipating;
    userSession.participationMode = mode;
    console.log(`🔄 Updated user ${clientId} participation:`, { 
      isParticipating, 
      mode,
      previousMode: userSession.participationMode 
    });
    this.broadcastUserStats(); // Ensure stats are broadcast immediately
  }
}

  private getUserStats() {
    const sessions = Array.from(this.userSessions.values());
    const connectedUsers = sessions.filter(s => s.isConnected).length;
    const authenticatedUsers = sessions.filter(s => s.isAuthenticated).length;
    const guestUsers = sessions.filter(s => !s.isAuthenticated).length;
    const participatingUsers = sessions.filter(s => s.isParticipating).length;
    const playingUsers = sessions.filter(s => s.participationMode === 'play').length;
    const watchingUsers = sessions.filter(s => s.participationMode === 'watch').length;
    const authenticatedPlaying = sessions.filter(s => s.isAuthenticated && s.participationMode === 'play').length;
    const guestPlaying = sessions.filter(s => !s.isAuthenticated && s.participationMode === 'play').length;
    const authenticatedWatching = sessions.filter(s => s.isAuthenticated && s.participationMode === 'watch').length;
    const guestWatching = sessions.filter(s => !s.isAuthenticated && s.participationMode === 'watch').length;
    
    return {
      connectedUsers,
      authenticatedUsers,
      guestUsers,
      participatingUsers,
      playingUsers,
      watchingUsers,
      authenticatedPlaying,
      guestPlaying,
      authenticatedWatching,
      guestWatching,
      totalSessions: sessions.length
    };
  }

  private broadcastUserStats() {
    const stats = this.getUserStats();
    console.log('📊 STATS UTILISATEURS:', stats);
    this.server.emit('userStats', stats);
  }

  // --- Gestion des événements et lobby ---
  private async initializeNextEvent() {
    const nextEvent = await this.eventService.getNextEvent();
    if (nextEvent) {
      this.scheduleEventCountdown(nextEvent);
    }
  }

  private scheduleEventCountdown(event: Event) {
    const now = new Date().getTime();
    const eventTime = new Date(event.startDate).getTime();
    const lobbyTime = eventTime - 5 * 60 * 1000;
    const startTime = eventTime;
    const endTime = eventTime + 2 * 60 * 1000;

    console.log(`Planification événement: ${event.theme}`);
    console.log(`Heure actuelle: ${new Date(now).toLocaleString()}`);
    console.log(`Heure événement: ${new Date(eventTime).toLocaleString()}`);
    console.log(`Heure lobby: ${new Date(lobbyTime).toLocaleString()}`);
    console.log(`Heure démarrage: ${new Date(startTime).toLocaleString()}`);
    console.log(`Lobby dans: ${Math.max(0, lobbyTime - now) / 1000}s`);
    console.log(`Début dans: ${Math.max(0, startTime - now) / 1000}s`);

    if (now >= lobbyTime && !event.lobbyOpen && now <= endTime) {
      console.log('Ouverture immédiate du lobby');
      this.openEventLobby(event);
    } else if (lobbyTime > now) {
      const delay = lobbyTime - now;
      console.log(`Programmation ouverture lobby dans ${delay / 1000}s`);
      this.nextEventTimer = setTimeout(() => {
        this.checkPendingEvents();
      }, delay);
    }

    this.broadcastNextEvent(event);
  }

  private startEventScheduler() {
    setInterval(async () => {
      try {
        if (this.currentLobby || this.isGlobalQuizActive()) return; // ✅ CORRECTION CLÉ
        await this.checkAndOpenLobbyIfNeeded();
      } catch (error) {
        console.error('❌ Erreur dans le scheduler d\'événements:', error);
      }
    }, 3000);

    setInterval(async () => {
      try {
        if (this.currentLobby || this.isGlobalQuizActive()) return; // ✅ CORRECTION CLÉ
        const eventsReady = await this.eventService.getEventsReadyForLobby();
        for (const event of eventsReady) {
          const now = new Date().getTime();
          const eventTime = new Date(event.startDate).getTime();
          const lobbyTime = eventTime - 5 * 60 * 1000;
          const endTime = eventTime + 2 * 60 * 1000;
          if (now >= lobbyTime && now <= endTime) {
            console.log(`🔄 BACKUP: Ouverture automatique du lobby pour: ${event.theme}`);
            await this.openEventLobby(event);
            break;
          }
        }
      } catch (error) {
        console.error('❌ Erreur dans le scheduler de backup:', error);
      }
    }, 10000);
  }

  private async openEventLobby(event: Event) {
    if (this.currentLobby || this.isGlobalQuizActive()) return; // ✅ CORRECTION CLÉ
    
    this.currentLobby = {
      event,
      participants: new Set(),
      countdownTimer: undefined,
      lobbyTimer: undefined,
    };

    if (!event.lobbyOpen) {
      await this.eventService.openLobby(event.id);
    }

    this.startEventCountdown();
    this.server.emit('lobbyOpened', {
      event: {
        id: event.id,
        theme: event.theme || 'Questions Aléatoires',
        numberOfQuestions: event.numberOfQuestions,
        startDate: event.startDate,
        minPlayers: event.minPlayers,
      },
    });
  }

  private startEventCountdown() {
    if (!this.currentLobby) return;

    const updateCountdown = () => {
      if (!this.currentLobby) return;
      const now = new Date().getTime();
      const eventTime = new Date(this.currentLobby.event.startDate).getTime();
      const timeLeft = Math.max(0, Math.floor((eventTime - now) / 1000));
      this.server.emit('eventCountdown', {
        timeLeft,
        participants: this.currentLobby.participants.size,
        minPlayers: this.currentLobby.event.minPlayers,
      });

      if (timeLeft <= 0) {
        this.startEventIfReady();
      }
    };

    updateCountdown();
    if (this.currentLobby) {
      this.currentLobby.countdownTimer = setInterval(updateCountdown, 1000);
    }
  }

  private async startEventIfReady() {
    if (!this.currentLobby) return;

    if (this.currentLobby.countdownTimer) {
      clearInterval(this.currentLobby.countdownTimer);
    }

    console.log(`Vérification finale des participants: ${this.currentLobby.participants.size}`);
    console.log('Participants:', Array.from(this.currentLobby.participants));

    if (this.currentLobby.participants.size > 0) {
      console.log("Démarrage de l'événement avec les joueurs présents");
      const lobbyParticipants = new Set(this.currentLobby.participants);
      await this.startEventQuiz(this.currentLobby.event, lobbyParticipants as Set<string>);
    } else {
      console.log('Événement annulé - aucun joueur');
      this.server.emit('eventCancelled', {
        reason: 'Aucun joueur présent',
        required: this.currentLobby.event.minPlayers,
        actual: this.currentLobby.participants.size,
      });
    }

    this.currentLobby = null; // ✅ Nettoyage après décision
    this.initializeNextEvent();
  }

  private async startEventQuiz(event: Event, participants: Set<string>) {
    console.log(`=== DÉMARRAGE QUIZ ÉVÉNEMENT ===`);
    console.log(`Thème: ${event.theme}`);
    console.log(`Nombre de questions demandées: ${event.numberOfQuestions}`);
    
    const questions = await this.getQuestionsByTheme(event.theme, event.numberOfQuestions);
    console.log(`Nombre de questions récupérées: ${questions.length}`);

    this.globalQuiz = {
      isActive: true,
      currentQuestionIndex: 0,
      questions,
      timeLimit: 30,
      timeLeft: 30,
      event,
      participants: new Map(),
    };

    participants.forEach((clientId) => {
      this.globalQuiz!.participants.set(clientId, { clientId, score: 0, answers: [] } as QuizParticipant);
      const session: QuizSession = {
        questions,
        currentIndex: 0,
        score: 0,
        answers: [],
        isWatching: false,
        timeLimit: 30,
        timeLeft: 30,
        joinedAt: 0,
      };
      this.quizSessions.set(clientId, session);
      this.updateUserParticipation(clientId, true, 'play');
    });

    console.log(`Quiz démarré avec ${participants.size} participants et ${questions.length} questions`);
    console.log(`=== FIN DÉMARRAGE QUIZ ÉVÉNEMENT ===`);

    this.server.emit('eventStarted', { event: { id: event.id, theme: event.theme, numberOfQuestions: event.numberOfQuestions } });

    participants.forEach((clientId) => {
      const client = this.server.sockets.sockets.get(clientId);
      if (client) {
        client.emit('autoStartQuiz', { theme: event.theme, limit: event.numberOfQuestions, timeLimit: 30 });
      }
    });

    this.startGlobalQuiz();
  }

  joinLobby(clientId: string) {
    if (!this.currentLobby) {
      const client = this.server.sockets.sockets.get(clientId);
      client?.emit('error', { message: 'Aucun lobby ouvert actuellement' });
      return;
    }

    const wasAlreadyInLobby = this.currentLobby.participants.has(clientId);
    this.currentLobby.participants.add(clientId);
    console.log(`Joueur ${clientId} ${wasAlreadyInLobby ? 'déjà dans' : 'a rejoint'} le lobby. Total: ${this.currentLobby.participants.size}`);
    this.broadcastLobbyUpdate();

    const client = this.server.sockets.sockets.get(clientId);
    client?.emit('lobbyJoined', {
      event: this.currentLobby.event,
      participants: this.currentLobby.participants.size,
    });
  }

  // Permet de rejoindre un événement déjà en cours en mode "watch"
 joinOngoingEvent(clientId: string) {
  if (!this.isGlobalQuizActive() || !this.globalQuiz) {
    const client = this.server.sockets.sockets.get(clientId);
    client?.emit('error', { message: 'Aucun événement en cours' });
    return;
  }

  // If the session exists already, just update the mode if needed
  const existingSession = this.quizSessions.get(clientId);
  const client = this.server.sockets.sockets.get(clientId);
  
  if (existingSession) {
    // If user was playing but should now be watching, update their mode
    if (!existingSession.isWatching && this.shouldBeInWatchMode(clientId)) {
      existingSession.isWatching = true;
      this.updateUserParticipation(clientId, true, 'watch');
    }
    this.sendCurrentQuestion(client!, existingSession);
    client?.emit('joinedInProgress', { mode: existingSession.isWatching ? 'watch' : 'play' });
    return;
  }

  // Determine mode: player if first question not expired, otherwise watcher
  const isFirstQuestionActive = this.globalQuiz.currentQuestionIndex === 0 && this.globalQuiz.timeLeft > 0;
  const isWatching = !isFirstQuestionActive || this.shouldBeInWatchMode(clientId);

  const session: QuizSession = {
    questions: this.globalQuiz.questions,
    currentIndex: this.globalQuiz.currentQuestionIndex,
    score: 0,
    answers: [],
    isWatching,
    timeLimit: this.globalQuiz.timeLimit,
    timeLeft: this.globalQuiz.timeLeft,
    joinedAt: this.globalQuiz.currentQuestionIndex,
  };

  this.quizSessions.set(clientId, session);
  this.globalQuiz.participants.set(clientId, { clientId, score: 0, answers: [] } as QuizParticipant);
  
  // CRITICAL FIX: Update user participation with correct mode
  this.updateUserParticipation(clientId, true, isWatching ? 'watch' : 'play');

  this.sendCurrentQuestion(client!, session);
  client?.emit('joinedInProgress', { mode: isWatching ? 'watch' : 'play' });
  this.broadcastPlayerStats();
  this.broadcastUserStats(); // Make sure to broadcast updated user stats
}

// Add this helper method to determine if user should be in watch mode
private shouldBeInWatchMode(clientId: string): boolean {
  if (!this.globalQuiz) return true;
  
  const participant = this.globalQuiz.participants.get(clientId);
  // If user has already answered incorrectly in this quiz, they should be watching
  if (participant && participant.answers.length > 0) {
    const lastAnswer = participant.answers[participant.answers.length - 1];
    if (!lastAnswer.correct && lastAnswer.questionId === this.globalQuiz.questions[this.globalQuiz.currentQuestionIndex]?.id) {
      return true;
    }
  }
  
  // If it's not the first question or time has expired, user should watch
  return this.globalQuiz.currentQuestionIndex > 0 || this.globalQuiz.timeLeft <= 0;
}



  private broadcastLobbyUpdate() {
    if (!this.currentLobby) return;
    console.log(`Mise à jour lobby: ${this.currentLobby.participants.size}/${this.currentLobby.event.minPlayers} participants`);
    this.server.emit('lobbyUpdate', {
      participants: this.currentLobby.participants.size,
      minPlayers: this.currentLobby.event.minPlayers,
    });
  }

  private broadcastNextEvent(event: Event) {
    this.server.emit('nextEvent', {
      id: event.id,
      theme: event.theme,
      startDate: event.startDate,
      numberOfQuestions: event.numberOfQuestions,
    });
  }

  private sendNextEventInfo(clientId: string) {
    this.eventService.getNextEvent().then((event) => {
      if (event) {
        const client = this.server.sockets.sockets.get(clientId);
        client?.emit('nextEvent', {
          id: event.id,
          theme: event.theme,
          startDate: event.startDate,
          numberOfQuestions: event.numberOfQuestions,
        });
      }
    });
  }

  private sendLobbyInfo(clientId: string) {
    if (!this.currentLobby) return;
    const client = this.server.sockets.sockets.get(clientId);
    client?.emit('lobbyOpened', {
      event: {
        id: this.currentLobby.event.id,
        theme: this.currentLobby.event.theme,
        numberOfQuestions: this.currentLobby.event.numberOfQuestions,
        startDate: this.currentLobby.event.startDate,
        minPlayers: this.currentLobby.event.minPlayers,
      },
    });
  }

  private sendEventCountdown(clientId: string) {
    if (!this.currentLobby) return;
    const now = new Date().getTime();
    const eventTime = new Date(this.currentLobby.event.startDate).getTime();
    const timeLeft = Math.max(0, Math.floor((eventTime - now) / 1000));
    const client = this.server.sockets.sockets.get(clientId);
    client?.emit('eventCountdown', {
      timeLeft,
      participants: this.currentLobby.participants.size,
      minPlayers: this.currentLobby.event.minPlayers,
    });
  }

  private async checkPendingEvents() {
    console.log('=== VÉRIFICATION ÉVÉNEMENTS ===');
    
    if (this.currentLobby || this.isGlobalQuizActive()) { // ✅ CORRECTION CLÉ
      console.log('Un lobby est déjà ouvert ou un quiz est en cours');
      return;
    }
    
    const eventsReady = await this.eventService.getEventsReadyForLobby();
    console.log(`Événements prêts: ${eventsReady.length}`);
    
    for (const event of eventsReady) {
      const now = new Date().getTime();
      const eventTime = new Date(event.startDate).getTime();
      const lobbyTime = eventTime - 5 * 60 * 1000;
      const endTime = eventTime + 2 * 60 * 1000;
      
      if (now >= lobbyTime && now <= endTime) {
        console.log(`\n🚀 OUVERTURE DU LOBBY`);
        this.currentLobby = {
          event,
          participants: new Set(),
          countdownTimer: undefined,
          lobbyTimer: undefined,
        };
        
        if (!event.lobbyOpen) {
          await this.eventService.openLobby(event.id);
        }
        
        this.startEventCountdown();
        this.server.emit('lobbyOpened', {
          event: {
            id: event.id,
            theme: event.theme || 'Questions Aléatoires',
            numberOfQuestions: event.numberOfQuestions,
            startDate: event.startDate,
            minPlayers: event.minPlayers,
          },
        });
        console.log(`Lobby ouvert avec succès!`);
        break;
      }
    }
    console.log('=== FIN VÉRIFICATION ===\n');
  }

  private async checkAndOpenLobbyIfNeeded() {
    try {
      console.log('🔍 VÉRIFICATION IMMÉDIATE À LA CONNEXION');
      
      if (this.currentLobby || this.isGlobalQuizActive()) { // ✅ CORRECTION CLÉ
        console.log('✅ Lobby déjà ouvert ou quiz en cours');
        return;
      }
      
      const activeEvents = await this.eventService.findActiveEvents();
      console.log(`📋 ${activeEvents.length} événements actifs trouvés`);
      
      const now = new Date().getTime();
      
      for (const event of activeEvents) {
        const eventTime = new Date(event.startDate).getTime();
        const lobbyTime = eventTime - 5 * 60 * 1000;
        const endTime = eventTime + 2 * 60 * 1000;
        const timeUntilEvent = Math.round((eventTime - now) / 1000);
        
        console.log(`\n🎯 Événement: ${event.theme}`);
        console.log(`⏰ Temps jusqu'à l'événement: ${timeUntilEvent}s`);
        console.log(`🚪 Lobby ouvert en DB: ${event.lobbyOpen}`);
        console.log(`📅 Dans la fenêtre de lobby: ${now >= lobbyTime && now <= endTime}`);
        
        if (now >= lobbyTime && now <= endTime) {
          console.log('🚀 CONDITIONS REMPLIES - OUVERTURE DU LOBBY');
          await this.openEventLobby(event);
          this.server.emit('lobbyOpened', {
            event: {
              id: event.id,
              theme: event.theme || 'Questions Aléatoires',
              numberOfQuestions: event.numberOfQuestions,
              startDate: event.startDate,
              minPlayers: event.minPlayers,
            },
          });
          console.log('✅ Lobby ouvert avec succès!');
          break;
        }
      }
      console.log('🔍 FIN VÉRIFICATION IMMÉDIATE\n');
    } catch (error) {
      console.error('❌ Erreur lors de la vérification des événements:', error);
    }
  }

  private async debugEventStatus() {
    const now = new Date();
    const events = await this.eventService.findActiveEvents();
    
    console.log('=== DEBUG STATUS ===');
    console.log(`Heure actuelle: ${now.toLocaleString()}`);
    console.log(`Lobby actuel: ${this.currentLobby ? 'OUVERT' : 'FERMÉ'}`);
    console.log(`Quiz global actif: ${this.isGlobalQuizActive()}`);
    console.log(`Événements actifs: ${events.length}`);
    
    for (const event of events) {
      const eventTime = new Date(event.startDate).getTime();
      const lobbyTime = eventTime - 5 * 60 * 1000;
      const endTime = eventTime + 2 * 60 * 1000;
      const nowTime = now.getTime();
      
      console.log(`\n--- Événement: ${event.theme} ---`);
      console.log(`ID: ${event.id}`);
      console.log(`Heure événement: ${new Date(eventTime).toLocaleString()}`);
      console.log(`Fenêtre lobby: ${new Date(lobbyTime).toLocaleString()} - ${new Date(endTime).toLocaleString()}`);
      console.log(`Lobby ouvert: ${event.lobbyOpen}`);
      console.log(`Dans fenêtre: ${nowTime >= lobbyTime && nowTime <= endTime}`);
      console.log(`Temps jusqu'au lobby: ${Math.round((lobbyTime - nowTime) / 1000)}s`);
    }
    console.log('===================\n');
  }

  private async emergencyLobbyCheck() {
    try {
      console.log('🚨 VÉRIFICATION D\'URGENCE DES LOBBIES');
      
      if (this.currentLobby || this.isGlobalQuizActive()) { // ✅ CORRECTION CLÉ
        console.log('✅ Lobby ouvert ou quiz en cours — pas d\'action');
        return;
      }
      
      const eventsInWindow = await this.eventService.getEventsInLobbyWindow();
      
      if (eventsInWindow.length > 0) {
        console.log(`⚠️  ALERTE: ${eventsInWindow.length} événement(s) dans la fenêtre de lobby mais aucun lobby ouvert!`);
        for (const event of eventsInWindow) {
          const now = new Date().getTime();
          const eventTime = new Date(event.startDate).getTime();
          const timeUntilEvent = Math.round((eventTime - now) / 1000);
          console.log(`🔧 CORRECTION: Ouverture forcée du lobby pour "${event.theme}" (dans ${timeUntilEvent}s)`);
          await this.openEventLobby(event);
          this.server.emit('emergencyLobbyOpened', {
            event: {
              id: event.id,
              theme: event.theme || 'Questions Aléatoires',
              numberOfQuestions: event.numberOfQuestions,
              startDate: event.startDate,
              minPlayers: event.minPlayers,
            },
            message: 'Lobby ouvert automatiquement - événement imminent!'
          });
          break;
        }
      } else {
        console.log('✅ Aucun événement dans la fenêtre de lobby');
      }
    } catch (error) {
      console.error('❌ Erreur lors de la vérification d\'urgence:', error);
    }
  }

  leaveLobby(clientId: string) {
    if (!this.currentLobby) {
      const client = this.server.sockets.sockets.get(clientId);
      client?.emit('error', { message: 'Aucun lobby ouvert actuellement' });
      return;
    }

    const wasInLobby = this.currentLobby.participants.has(clientId);
    if (wasInLobby) {
      this.currentLobby.participants.delete(clientId);
      console.log(`Joueur ${clientId} a quitté le lobby. Total: ${this.currentLobby.participants.size}`);
      this.broadcastLobbyUpdate();
    }

    const client = this.server.sockets.sockets.get(clientId);
    client?.emit('lobbyLeft', {
      success: true,
      participants: this.currentLobby.participants.size,
    });
  }

  async forceEventCheck() {
    console.log('🔄 VÉRIFICATION FORCÉE DEMANDÉE');
    await this.checkAndOpenLobbyIfNeeded();
    await this.emergencyLobbyCheck();
  }

  // Nouvelle méthode pour gérer la pause publicitaire avant la dernière question
  private startAdBreakBeforeFinalQuestion() {
    if (!this.globalQuiz) return;

    console.log('📺 Démarrage de la pause publicitaire avant la dernière question');
    
    // Envoyer l'événement de pause publicitaire à tous les clients
    this.server.emit('adBreakStarted', {
      duration: 15, // 15 secondes
      message: 'Pause publicitaire avant la dernière question',
      isFinalQuestion: true
    });

    // Démarrer le compte à rebours de 15 secondes
    let countdown = 15;
    const adCountdownInterval = setInterval(() => {
      countdown--;
      this.server.emit('adBreakCountdown', { timeLeft: countdown });
      
      if (countdown <= 0) {
        clearInterval(adCountdownInterval);
        this.server.emit('adBreakEnded');
        
        // Démarrer la dernière question après la publicité
        this.globalQuiz!.timeLeft = this.globalQuiz!.timeLimit;
        this.startGlobalQuiz();
      }
    }, 1000);
  }

  // Nouvelle méthode pour gérer la première réponse correcte sur la dernière question
  private async handleFinalQuestionCorrectAnswer(clientId: string, payload: SubmitAnswerPayload) {
    if (!this.globalQuiz) return;

    console.log(`🏆 Première réponse correcte sur la dernière question par ${clientId}`);
    
    // Arrêter tous les timers
    if (this.globalQuiz.timerInterval) clearInterval(this.globalQuiz.timerInterval);
    if (this.globalQuiz.timer) clearTimeout(this.globalQuiz.timer);

    const session = this.quizSessions.get(clientId);
    if (session) {
      const currentQuestion = session.questions[session.currentIndex];
      
      // Marquer la réponse comme correcte
      session.score++;
      const participant = this.globalQuiz.participants?.get(clientId);
      if (participant) {
        participant.score = session.score;
        participant.finishedAt = new Date();
        participant.lastCorrectAnswerTime = Date.now();
        
        const answerData = {
          questionId: currentQuestion.id,
          userAnswer: payload.answer,
          correct: true,
          submittedAt: Date.now(),
        };
        
        session.answers.push(answerData);
        participant.answers.push(answerData);
      }
    }

    // Obtenir les informations du gagnant
    const winnerInfo = await this.getWinnerInfo(clientId);
    const winnerUsername = winnerInfo.username || null;
    const winnerPhone = winnerInfo.phoneNumber || null;
    
    // Fermer l'événement immédiatement
    if (this.globalQuiz.event) {
      if (winnerPhone) {
        await this.eventService.completeEvent(this.globalQuiz.event.id, winnerPhone);
      } else {
        await this.eventService.completeEvent(this.globalQuiz.event.id, clientId);
      }

      // Envoyer l'événement de victoire immédiate
      this.server.emit('immediateWinner', {
        eventId: this.globalQuiz.event.id,
        winner: winnerUsername || clientId,
        winnerPhone,
        winnerDisplay: winnerUsername ? `🏆 ${winnerUsername}` : `Session: ${clientId}`,
        message: 'Première réponse correcte sur la dernière question !'
      });
    }

    // Compléter le quiz pour tous les participants
    this.quizSessions.forEach((session, sessionClientId) => {
      const client = this.server.sockets.sockets.get(sessionClientId);
      if (client) {
        client.emit('quizCompleted', {
          score: session.score,
          totalQuestions: session.questions.length,
          answers: session.answers,
          joinedAt: session.joinedAt,
          winner: winnerUsername || clientId,
          isWinner: sessionClientId === clientId,
          immediateWin: true
        });
      }
    });

    // Nettoyer après 5 secondes
    setTimeout(() => this.server.disconnectSockets(true), 5000);

    this.globalQuiz = null;
    this.quizSessions.clear();
    this.currentLobby = null;
  }
}