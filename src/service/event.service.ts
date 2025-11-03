import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Event } from '../model/event.entity';

@Injectable()
export class EventService {
  constructor(
    @InjectModel(Event.name)
    private readonly eventModel: Model<Event>,
  ) {}

  async findActiveEvents(): Promise<Event[]> {
    return this.eventModel.find({ isCompleted: false }).sort({ startDate: 1 }).exec();
  }

  async completeEvent(eventId: string, winnerPhone: string): Promise<Event | null> {
    console.log(`🏁 Finalisation de l'événement ${eventId} avec le gagnant: ${winnerPhone}`);
    const result = await this.eventModel.findByIdAndUpdate(
      eventId,
      { winner: winnerPhone, isCompleted: true },
      { new: true }
    ).exec();
    
    if (result) {
      console.log(`✅ Événement finalisé avec succès: ${result.theme}`);
    } else {
      console.log(`❌ Échec de la finalisation de l'événement ${eventId}`);
    }
    
    return result;
  }

  async createEvent(theme: string, startDate: Date, numberOfQuestions: number, minPlayers: number = 2): Promise<Event> {
    const event = new this.eventModel({
      theme,
      startDate,
      numberOfQuestions,
      minPlayers
    });
    return event.save();
  }

  async getNextEvent(): Promise<Event | null> {
    const now = new Date();
    // Chercher le prochain événement qui n'est pas encore terminé
    return this.eventModel
      .findOne({
        isCompleted: false,
        startDate: { $gt: new Date(now.getTime() - 2 * 60 * 1000) } // Inclure les événements qui ont commencé il y a moins de 2 minutes
      })
      .sort({ startDate: 1 })
      .exec();
  }

  async openLobby(eventId: string): Promise<Event | null> {
    console.log(`🔓 Ouverture du lobby pour l'événement ${eventId}`);
    const result = await this.eventModel.findByIdAndUpdate(
      eventId,
      { lobbyOpen: true },
      { new: true }
    ).exec();
    
    if (result) {
      console.log(`✅ Lobby ouvert avec succès pour: ${result.theme}`);
    } else {
      console.log(`❌ Échec de l'ouverture du lobby pour l'événement ${eventId}`);
    }
    
    return result;
  }

  async getEventsReadyForLobby(): Promise<Event[]> {
    const now = new Date();
    const fiveMinutesBefore = new Date(now.getTime() - 5 * 60 * 1000);
    const twoMinutesAfter = new Date(now.getTime() + 2 * 60 * 1000);
    
    // Chercher les événements qui sont dans la fenêtre de lobby (5 min avant à 2 min après)
    return this.eventModel.find({
      isCompleted: false,
      startDate: { 
        $gte: fiveMinutesBefore, // L'événement commence dans moins de 5 minutes
        $lte: new Date(now.getTime() + 5 * 60 * 1000) // Ou dans les 5 prochaines minutes
      }
    }).sort({ startDate: 1 }).exec();
  }

  async getEventsInLobbyWindow(): Promise<Event[]> {
    const now = new Date();
    const fiveMinutesBefore = new Date(now.getTime() - 5 * 60 * 1000);
    const twoMinutesAfter = new Date(now.getTime() + 2 * 60 * 1000);
    
    return this.eventModel.find({
      isCompleted: false,
      startDate: { 
        $gte: fiveMinutesBefore,
        $lte: twoMinutesAfter
      }
    }).sort({ startDate: 1 }).exec();
  }

  async startEvent(eventId: string): Promise<Event | null> {
    console.log(`🚀 Démarrage de l'événement ${eventId}`);
    const result = await this.eventModel.findByIdAndUpdate(
      eventId,
      { isStarted: true },
      { new: true }
    ).exec();
    
    if (result) {
      console.log(`✅ Événement démarré avec succès: ${result.theme}`);
    } else {
      console.log(`❌ Échec du démarrage de l'événement ${eventId}`);
    }
    
    return result;
  }

  async updateEvent(eventId: string, updates: Partial<Event>): Promise<Event | null> {
    const result = await this.eventModel.findByIdAndUpdate(
      eventId,
      updates,
      { new: true }
    ).exec();
    return result;
  }
}