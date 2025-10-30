import { Event } from '../model/event.entity';
import { Question } from '../model/question.entity';

export interface GlobalQuiz {
  isActive: boolean;
  currentQuestionIndex: number;
  questions: Question[];
  timeLimit: number;
  timeLeft: number;
  timer?: NodeJS.Timeout;
  timerInterval?: NodeJS.Timeout;
  event?: Event;
  participants: Map<string, QuizParticipant>;
}

export interface EventLobby {
  event: Event;
  participants: Set<string>;
  countdownTimer?: NodeJS.Timeout;
  lobbyTimer?: NodeJS.Timeout;
}

export interface QuizParticipant {
  clientId: string;
  score: number;
  finishedAt?: Date;
  lastCorrectAnswerTime?: number;
  answers: Array<{
    questionId: number;
    userAnswer: number;
    correct: boolean;
    submittedAt: number;
  }>;
}

export interface CreateEventData {
  theme: string;
  startDate: string;
  numberOfQuestions: number;
  minPlayers?: number;
}
