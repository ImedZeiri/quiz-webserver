export interface StartQuizPayload {
  theme?: string;
  limit?: number;
  timeLimit?: number;
}

export interface SubmitAnswerPayload {
  questionId: number;
  answer: number;
}

export interface PlayerStats {
  activePlayers: number;
  watchingPlayers: number;
  totalPlayers: number;
}

export interface QuizQuestionResponse {
  question: {
    id: number;
    theme: string;
    questionText: string;
    response1: string;
    response2: string;
    response3: string;
    response4: string;
  };
  questionNumber: number;
  totalQuestions: number;
  previousAnswer: any;
  isWatching: boolean;
  timeLeft: number;
}

export interface QuizCompletedResponse {
  score: number;
  totalQuestions: number;
  answers: any[];
  joinedAt: number;
  winner?: string;
  isWinner: boolean;
}

export interface EventCompletedResponse {
  eventId: string;
  winner?: string;
  winnerPhone?: string;
  winnerDisplay?: string;
}

export interface WinnerInfo {
  sessionId: string;
  username?: string;
  phoneNumber?: string;
  userId?: string;
}