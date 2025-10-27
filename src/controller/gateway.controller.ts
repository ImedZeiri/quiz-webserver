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
  }

  handleDisconnect(client: Socket) {
    console.log(`Client disconnected: ${client.id}`);
    const session = this.quizSessions.get(client.id);
    if (session?.timer) clearTimeout(session.timer);
    if (session?.timerInterval) clearInterval(session.timerInterval);
    this.quizSessions.delete(client.id);
  }

  @SubscribeMessage('startQuiz')
  async handleStartQuiz(client: Socket, payload: { theme?: string; limit?: number; timeLimit?: number }) {
    const { theme, limit = 10, timeLimit = 30 } = payload || {};
    const questions = await this.getQuestionsByTheme(theme, limit);
    
    if (questions.length === 0) {
      client.emit('error', { message: 'Aucune question trouvée pour ce thème' });
      return;
    }

    const session: QuizSession = {
      questions,
      currentIndex: 0,
      score: 0,
      answers: [],
      isWatching: false,
      timeLimit,
      timeLeft: timeLimit
    };
    
    this.quizSessions.set(client.id, session);
    this.sendQuestion(client, session);
  }

  private sendQuestion(client: Socket, session: QuizSession) {
    if (session.timer) clearTimeout(session.timer);
    if (session.timerInterval) clearInterval(session.timerInterval);

    const currentQuestion = session.questions[session.currentIndex];
    session.timeLeft = session.timeLimit;
    
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
      previousAnswer: session.currentIndex > 0 ? session.answers[session.answers.length - 1] : null,
      isWatching: session.isWatching,
      timeLeft: session.timeLeft
    });

    // Envoyer les mises à jour du timer chaque seconde
    session.timerInterval = setInterval(() => {
      session.timeLeft--;
      client.emit('timerUpdate', { timeLeft: session.timeLeft });
      
      if (session.timeLeft <= 0) {
        this.handleTimeExpired(client, session);
      }
    }, 1000);

    // Timer de sécurité
    session.timer = setTimeout(() => {
      this.handleTimeExpired(client, session);
    }, session.timeLimit * 1000);
  }

  private handleTimeExpired(client: Socket, session: QuizSession) {
    if (session.timerInterval) clearInterval(session.timerInterval);
    if (session.timer) clearTimeout(session.timer);
    
    const currentQuestion = session.questions[session.currentIndex];
    
    // Ajouter réponse vide (temps expiré)
    session.answers.push({
      questionId: currentQuestion.id,
      userAnswer: 0, // 0 = pas de réponse
      correct: false
    });

    session.isWatching = true; // Mode surveillance activé
    session.currentIndex++;

    if (session.currentIndex >= session.questions.length) {
      this.completeQuiz(client, session);
    } else {
      this.sendQuestion(client, session);
    }
  }

  private completeQuiz(client: Socket, session: QuizSession) {
    if (session.timer) clearTimeout(session.timer);
    if (session.timerInterval) clearInterval(session.timerInterval);
    
    client.emit('quizCompleted', {
      score: session.score,
      totalQuestions: session.questions.length,
      answers: session.answers
    });
    
    this.quizSessions.delete(client.id);
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

    // Arrêter les timers
    if (session.timer) clearTimeout(session.timer);
    if (session.timerInterval) clearInterval(session.timerInterval);

    const isCorrect = currentQuestion.correctResponse === payload.answer;
    if (isCorrect) {
      session.score++;
    } else {
      session.isWatching = true;
    }

    session.answers.push({
      questionId: payload.questionId,
      userAnswer: payload.answer,
      correct: isCorrect
    });

    session.currentIndex++;

    if (session.currentIndex >= session.questions.length) {
      this.completeQuiz(client, session);
    } else {
      this.sendQuestion(client, session);
    }
  }
}
