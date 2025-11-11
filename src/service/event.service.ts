import { Injectable, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Event } from '../model/event.entity';

@Injectable()
export class EventService implements OnModuleInit, OnModuleDestroy {
  private lobbyInterval: NodeJS.Timeout;

  constructor(
    @InjectModel(Event.name)
    private readonly eventModel: Model<Event>,
  ) {}

  onModuleInit() {
    // Start only the lobby scheduler when the module initializes
    this.startLobbyScheduler();
    
    // Check if we need to create an initial event on startup
    this.initializeFirstEvent();
  }

  onModuleDestroy() {
    // Clear the interval when the module is destroyed
    if (this.lobbyInterval) {
      clearInterval(this.lobbyInterval);
    }
  }

  private async initializeFirstEvent(): Promise<void> {
    try {
      // Check if there are any active events
      const activeEvents = await this.findActiveEvents();
      
      if (activeEvents.length === 0) {
        // No active events, create one starting in 15 minutes
        const startDate = new Date(Date.now() + 15 * 60 * 1000);
        const theme = `Online Event - ${startDate.toLocaleTimeString()}`;
        
        await this.createEvent(theme, startDate, 5, 2);
        console.log(`✅ Created initial event: ${theme} at ${startDate}`);
      } else {
        console.log(`⏭️ Active events already exist, no need for initial event`);
        
        // Check if we need to schedule the next event based on the last active event
        await this.checkAndScheduleNextEvent();
      }
    } catch (error) {
      console.error('❌ Error creating initial event:', error);
    }
  }

  private async checkAndScheduleNextEvent(): Promise<void> {
    try {
      // Find the last event (whether completed or active)
      const lastEvent = await this.eventModel
        .findOne()
        .sort({ startDate: -1 })
        .exec();

      if (lastEvent && lastEvent.isCompleted) {
        // If the last event is completed, check if we need to schedule a new one
        const nextEventExists = await this.eventModel.findOne({
          isCompleted: false,
          startDate: { $gt: new Date() }
        }).exec();

        if (!nextEventExists) {
          // Schedule next event 15 minutes from now
          await this.scheduleNextEvent();
        }
      }
    } catch (error) {
      console.error('❌ Error checking and scheduling next event:', error);
    }
  }

  private startLobbyScheduler(): void {
    // Run every minute to check for events that need lobby opened
    this.lobbyInterval = setInterval(async () => {
      await this.checkAndOpenLobbies();
    }, 60 * 1000);

    // Also run immediately on startup
    this.checkAndOpenLobbies();
  }

  async checkAndOpenLobbies(): Promise<void> {
    console.log('🔓 Checking for events that need lobby opened...');
    
    try {
      const now = new Date();
      const twoMinutesFromNow = new Date(now.getTime() + 2 * 60 * 1000);
      
      // Find events that start in exactly 2 minutes and don't have lobby open yet
      const eventsToOpen = await this.eventModel.find({
        isCompleted: false,
        lobbyOpen: false,
        startDate: {
          $gte: new Date(twoMinutesFromNow.getTime() - 30 * 1000), // 30 seconds before 2-minute mark
          $lte: new Date(twoMinutesFromNow.getTime() + 30 * 1000)  // 30 seconds after 2-minute mark
        }
      }).exec();

      for (const event of eventsToOpen) {
        await this.openLobby((event._id as any).toString());
        console.log(`✅ Auto-opened lobby for event: ${event.theme} starting at ${event.startDate}`);
      }

      if (eventsToOpen.length === 0) {
        console.log('⏭️ No events need lobby opening at this time');
      }
    } catch (error) {
      console.error('❌ Error opening lobbies:', error);
    }
  }

  async scheduleNextEvent(): Promise<void> {
    try {
      // Create next event 15 minutes from now
      const nextEventTime = new Date(Date.now() + 15 * 60 * 1000);
      
      // Check if there's already an event scheduled around this time
      const existingEvent = await this.eventModel.findOne({
        startDate: {
          $gte: new Date(nextEventTime.getTime() - 2 * 60 * 1000), // 2 minutes before
          $lte: new Date(nextEventTime.getTime() + 2 * 60 * 1000)  // 2 minutes after
        },
        isCompleted: false
      }).exec();

      if (!existingEvent) {
        const theme = `Online Event - ${nextEventTime.toLocaleTimeString()}`;
        await this.createEvent(theme, nextEventTime, 5, 2);
        console.log(`✅ Scheduled next event: ${theme} at ${nextEventTime}`);
      } else {
        console.log(`⏭️ Event already exists for this time slot: ${existingEvent.theme}`);
      }
    } catch (error) {
      console.error('❌ Error scheduling next event:', error);
    }
  }

  async findActiveEvents(): Promise<Event[]> {
    return this.eventModel.find({ isCompleted: false }).sort({ startDate: 1 }).exec();
  }

  async completeEvent(eventId: string, winnerPhone: string): Promise<Event | null> {
    console.log(`🏁 Finalisation de l'événement ${eventId} avec le gagnant: ${winnerPhone}`);
    
    try {
      const result = await this.eventModel.findByIdAndUpdate(
        eventId,
        { winner: winnerPhone, isCompleted: true },
        { new: true }
      ).exec();
      
      if (result) {
        console.log(`✅ Événement finalisé avec succès: ${result.theme}`);
        
        // Schedule the next event 15 minutes from now
        await this.scheduleNextEvent();
      } else {
        console.log(`❌ Échec de la finalisation de l'événement ${eventId}`);
      }
      
      return result;
    } catch (error) {
      console.error('❌ Error completing event:', error);
      throw error;
    }
  }

  async createEvent(theme: string, startDate: Date, numberOfQuestions: number, minPlayers: number = 2): Promise<Event> {
    const event = new this.eventModel({
      theme,
      startDate,
      numberOfQuestions,
      minPlayers,
      lobbyOpen: false,
      isStarted: false,
      isCompleted: false
    });
    return event.save();
  }

  async getNextEvent(): Promise<Event | null> {
    const now = new Date();
    return this.eventModel
      .findOne({
        isCompleted: false,
        startDate: { $gt: now }
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
    const twoMinutesFromNow = new Date(now.getTime() + 2 * 60 * 1000);
    
    return this.eventModel.find({
      isCompleted: false,
      startDate: { 
        $lte: twoMinutesFromNow,
        $gt: now
      },
      lobbyOpen: false
    }).sort({ startDate: 1 }).exec();
  }

  async getEventsInLobbyWindow(): Promise<Event[]> {
    const now = new Date();
    const twoMinutesBefore = new Date(now.getTime() - 2 * 60 * 1000);
    
    return this.eventModel.find({
      isCompleted: false,
      startDate: { 
        $gte: twoMinutesBefore,
        $lte: now
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