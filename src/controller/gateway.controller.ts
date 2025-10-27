import {
  WebSocketGateway,
  WebSocketServer,
  OnGatewayConnection,
  OnGatewayDisconnect,
  SubscribeMessage,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { QuestionService } from '../service/question.service';
import { Question } from '../model/question.entity';

interface QuizSession {
  questions: Question[];
  currentIndex: number;
  score: number;
  answers: { questionId: number; userAnswer: number; correct: boolean }[];
  isWatching: boolean;
  timer?: NodeJS.Timeout;
  timerInterval?: NodeJS.Timeout;
  timeLimit: number;
  timeLeft: number;
  pendingAnswer?: { questionId: number; answer: number };
  joinedAt: number;
}

interface GlobalQuiz {
  isActive: boolean;
  currentQuestionIndex: number;
  questions: Question[];
  timeLimit: number;
  timeLeft: number;
  timer?: NodeJS.Timeout;
  timerInterval?: NodeJS.Timeout;
}

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

  private quizSessions = new Map<string, QuizSession>();
  private globalQuiz: GlobalQuiz | null = null;

  private async getQuestionsByTheme(theme?: string, limit: number = 10): Promise<Question[]> {
    if (theme) {
      const themeQuestions = await this.questionService.findByTheme(theme);
      return themeQuestions.slice(0, limit);
    }
    return this.questionService.findRandomQuestions(limit);
  }

  constructor(private readonly questionService: QuestionService) {}

  handleConnection(client: Socket) {
    console.log(`Client connected: ${client.id}`);
    this.broadcastPlayerStats();
  }

  handleDisconnect(client: Socket) {
    console.log(`Client disconnected: ${client.id}`);
    const session = this.quizSessions.get(client.id);
    if (session?.timer) clearTimeout(session.timer);
    if (session?.timerInterval) clearInterval(session.timerInterval);
    this.quizSessions.delete(client.id);
    this.broadcastPlayerStats();
  }

  @SubscribeMessage('startQuiz')
  async handleStartQuiz(client: Socket, payload: { theme?: string; limit?: number; timeLimit?: number }) {
    const { theme, limit = 10, timeLimit = 30 } = payload || {};
    
    // Si un quiz global est déjà actif, rejoindre en mode watch
    if (this.globalQuiz?.isActive) {
      const session: QuizSession = {
        questions: this.globalQuiz.questions,
        currentIndex: this.globalQuiz.currentQuestionIndex,
        score: 0,
        answers: [],
        isWatching: true,
        timeLimit: this.globalQuiz.timeLimit,
        timeLeft: this.globalQuiz.timeLeft,
        joinedAt: this.globalQuiz.currentQuestionIndex
      };
      
      this.quizSessions.set(client.id, session);
      this.sendCurrentQuestion(client, session);
      this.broadcastPlayerStats();
      return;
    }
    
    // Démarrer un nouveau quiz global
    const questions = await this.getQuestionsByTheme(theme, limit);
    
    if (questions.length === 0) {
      client.emit('error', { message: 'Aucune question trouvée pour ce thème' });
      return;
    }

    this.globalQuiz = {
      isActive: true,
      currentQuestionIndex: 0,
      questions,
      timeLimit,
      timeLeft: timeLimit
    };

    const session: QuizSession = {
      questions,
      currentIndex: 0,
      score: 0,
      answers: [],
      isWatching: false,
      timeLimit,
      timeLeft: timeLimit,
      joinedAt: 0
    };
    
    this.quizSessions.set(client.id, session);
    this.startGlobalQuiz();
  }

  private startGlobalQuiz() {
    if (!this.globalQuiz) return;
    
    this.broadcastCurrentQuestion();
    
    this.globalQuiz.timerInterval = setInterval(() => {
      if (!this.globalQuiz) return;
      
      this.globalQuiz.timeLeft--;
      this.server.emit('timerUpdate', { 
        timeLeft: this.globalQuiz.timeLeft,
        ...this.getPlayerStats()
      });
      
      if (this.globalQuiz.timeLeft <= 0) {
        this.handleGlobalTimeExpired();
      }
    }, 1000);

    this.globalQuiz.timer = setTimeout(() => {
      this.handleGlobalTimeExpired();
    }, this.globalQuiz.timeLimit * 1000);
  }

  private broadcastCurrentQuestion() {
    if (!this.globalQuiz) return;
    
    const currentQuestion = this.globalQuiz.questions[this.globalQuiz.currentQuestionIndex];
    
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
        response4: currentQuestion.response4
      },
      questionNumber: session.currentIndex + 1,
      totalQuestions: session.questions.length,
      previousAnswer: session.answers.length > 0 ? session.answers[session.answers.length - 1] : null,
      isWatching: session.isWatching,
      timeLeft: session.timeLeft,
      ...this.getPlayerStats()
    });
  }

  private handleGlobalTimeExpired() {
    if (!this.globalQuiz) return;
    
    if (this.globalQuiz.timerInterval) clearInterval(this.globalQuiz.timerInterval);
    if (this.globalQuiz.timer) clearTimeout(this.globalQuiz.timer);
    
    // Traiter les réponses de tous les joueurs
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
          } else {
            session.isWatching = true;
          }
        } else if (!session.isWatching) {
          session.isWatching = true;
        }
        
        session.answers.push({
          questionId: currentQuestion.id,
          userAnswer,
          correct: isCorrect
        });
        
        session.pendingAnswer = undefined;
      }
    });

    this.globalQuiz.currentQuestionIndex++;
    
    if (this.globalQuiz.currentQuestionIndex >= this.globalQuiz.questions.length) {
      this.completeGlobalQuiz();
    } else {
      this.globalQuiz.timeLeft = this.globalQuiz.timeLimit;
      this.startGlobalQuiz();
    }
  }

  private completeGlobalQuiz() {
    if (!this.globalQuiz) return;
    
    if (this.globalQuiz.timerInterval) clearInterval(this.globalQuiz.timerInterval);
    if (this.globalQuiz.timer) clearTimeout(this.globalQuiz.timer);
    
    this.quizSessions.forEach((session, clientId) => {
      const client = this.server.sockets.sockets.get(clientId);
      if (client) {
        client.emit('quizCompleted', {
          score: session.score,
          totalQuestions: session.questions.length,
          answers: session.answers,
          joinedAt: session.joinedAt
        });
      }
    });
    
    this.globalQuiz = null;
    this.quizSessions.clear();
    this.broadcastPlayerStats();
  }

  private getPlayerStats() {
    const activePlayers = Array.from(this.quizSessions.values()).filter(s => !s.isWatching).length;
    const watchingPlayers = Array.from(this.quizSessions.values()).filter(s => s.isWatching).length;
    
    return {
      activePlayers,
      watchingPlayers,
      totalPlayers: activePlayers + watchingPlayers
    };
  }

  private broadcastPlayerStats() {
    this.server.emit('playerStats', this.getPlayerStats());
  }

  @SubscribeMessage('submitAnswer')
  async handleSubmitAnswer(client: Socket, payload: { questionId: number; answer: number }) {
    const session = this.quizSessions.get(client.id);
    if (!session) {
      client.emit('error', { message: 'Aucune session de quiz active' });
      return;
    }

    if (session.isWatching) {
      client.emit('error', { message: 'Vous êtes en mode surveillance - réponses bloquées' });
      return;
    }

    const currentQuestion = session.questions[session.currentIndex];
    if (currentQuestion.id !== payload.questionId) {
      client.emit('error', { message: 'Question invalide' });
      return;
    }

    if (session.timeLeft <= 0) {
      client.emit('error', { message: 'Temps expiré - réponse non acceptée' });
      return;
    }

    session.pendingAnswer = {
      questionId: payload.questionId,
      answer: payload.answer
    };

    client.emit('answerQueued', {
      questionId: payload.questionId,
      answer: payload.answer,
      timeLeft: session.timeLeft
    });
    
    this.broadcastPlayerStats();
  }
}
