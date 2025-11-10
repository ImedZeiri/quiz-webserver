import { Injectable, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Event } from '../model/event.entity';

@Injectable()
export class EventService implements OnModuleInit, OnModuleDestroy {
  private eventInterval: NodeJS.Timeout;

  constructor(
    @InjectModel(Event.name)
    private readonly eventModel: Model<Event>,
  ) {}

  onModuleInit() {
    // Start the interval when the module initializes
    this.startEventScheduler();
  }

  onModuleDestroy() {
    // Clear the interval when the module is destroyed
    if (this.eventInterval) {
      clearInterval(this.eventInterval);
    }
  }

  private startEventScheduler(): void {
    // Run every 10 minutes (600,000 milliseconds)
    this.eventInterval = setInterval(async () => {
      await this.createScheduledEvent();
    }, 10 * 60 * 1000);

    // Also run immediately on startup
    this.createScheduledEvent();
  }

  async createScheduledEvent(): Promise<void> {
    console.log('⏰ Checking for scheduled event creation...');
    
    try {
      const now = new Date();
      const nextEventTime = new Date(now.getTime() + 10 * 60 * 1000); // 10 minutes from now
      
      // Check if there's already an event scheduled for this time window
      const existingEvent = await this.eventModel.findOne({
        startDate: {
          $gte: new Date(nextEventTime.getTime() - 2 * 60 * 1000), // 2 minutes before
          $lte: new Date(nextEventTime.getTime() + 2 * 60 * 1000)  // 2 minutes after
        },
        isCompleted: false
      }).exec();

      if (!existingEvent) {
        // Create a new event
        const theme = `Online Event - ${nextEventTime.toLocaleTimeString()}`;
        const event = await this.createEvent(
          theme,
          nextEventTime,
          5, // default number of questions
          2   // default min players
        );
        
        console.log(`✅ Auto-created event: ${theme} at ${nextEventTime}`);
      } else {
        console.log(`⏭️  Event already exists for this time slot: ${existingEvent.theme}`);
      }
    } catch (error) {
      console.error('❌ Error creating scheduled event:', error);
    }
  }

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
    return this.eventModel
      .findOne({
        isCompleted: false,
        startDate: { $gt: new Date(now.getTime() - 2 * 60 * 1000) }
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
    
    return this.eventModel.find({
      isCompleted: false,
      startDate: { 
        $gte: fiveMinutesBefore,
        $lte: new Date(now.getTime() + 5 * 60 * 1000)
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