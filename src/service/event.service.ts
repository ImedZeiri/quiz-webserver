import { Injectable, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Event } from '../model/event.entity';

@Injectable()
export class EventService implements OnModuleInit, OnModuleDestroy {
  private lobbyInterval: NodeJS.Timeout;
  private eventCreationInterval: NodeJS.Timeout;

  constructor(
    @InjectModel(Event.name)
    private readonly eventModel: Model<Event>,
  ) {}

  onModuleInit() {
    // Start both schedulers when the module initializes
    this.startLobbyScheduler();
    this.startEventCreationScheduler();
    
    // Check if we need to create an initial event on startup
    this.initializeFirstEvent();
  }

  onModuleDestroy() {
    // Clear all intervals when the module is destroyed
    if (this.lobbyInterval) {
      clearInterval(this.lobbyInterval);
    }
    if (this.eventCreationInterval) {
      clearInterval(this.eventCreationInterval);
    }
  }

  private startEventCreationScheduler(): void {
    // Create events every 15 minutes
    this.eventCreationInterval = setInterval(async () => {
      await this.createScheduledEvent();
    }, 15 * 60 * 1000); // 15 minutes

    console.log('✅ Event creation scheduler started - creating events every 15 minutes');
  }

  private async createScheduledEvent(): Promise<void> {
    try {
      // Calculate next event time (15 minutes from now)
      const startDate = new Date(Date.now() + 15 * 60 * 1000);
      const theme = `Online Event - ${startDate.toLocaleTimeString()}`;
      
      await this.createEvent(theme, startDate, 5, 2);
      console.log(`✅ Created scheduled event: ${theme} at ${startDate}`);
    } catch (error) {
      console.error('❌ Error creating scheduled event:', error);
    }
  }

  private async initializeFirstEvent(): Promise<void> {
    try {
      // Check if there are any upcoming events in the next 30 minutes
      const now = new Date();
      const thirtyMinutesFromNow = new Date(now.getTime() + 30 * 60 * 1000);
      
      const upcomingEvents = await this.eventModel.find({
        isCompleted: false,
        startDate: { $gte: now, $lte: thirtyMinutesFromNow }
      }).sort({ startDate: 1 }).exec();
      
      if (upcomingEvents.length === 0) {
        // No upcoming events, create one starting in 15 minutes
        const startDate = new Date(Date.now() + 15 * 60 * 1000);
        const theme = `Online Event - ${startDate.toLocaleTimeString()}`;
        
        await this.createEvent(theme, startDate, 5, 2);
        console.log(`✅ Created initial event: ${theme} at ${startDate}`);
      } else {
        console.log(`⏭️ Upcoming events already exist, no need for initial event`);
        
        // Schedule the next event creation based on the last event
        const lastEvent = upcomingEvents[upcomingEvents.length - 1];
        const timeUntilNextEvent = lastEvent.startDate.getTime() - now.getTime() + 15 * 60 * 1000;
        
        if (timeUntilNextEvent > 0) {
          setTimeout(() => {
            this.createScheduledEvent();
          }, timeUntilNextEvent);
          
          console.log(`⏰ Next event creation scheduled in ${Math.round(timeUntilNextEvent / 60000)} minutes`);
        }
      }
    } catch (error) {
      console.error('❌ Error creating initial event:', error);
    }
  }

  private startLobbyScheduler(): void {
    // Run every minute to check for events that need lobby opened (2 minutes before start)
    this.lobbyInterval = setInterval(async () => {
      await this.checkAndOpenLobbies();
    }, 60 * 1000);

    // Also run immediately on startup
    this.checkAndOpenLobbies();
    console.log('✅ Lobby scheduler started - checking every minute for lobby openings');
  }

  async checkAndOpenLobbies(): Promise<void> {
    console.log('🔓 Checking for events that need lobby opened (2 minutes before start)...');
    
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
        
        // Note: No need to schedule next event here since we have the 15-minute interval
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

  // Helper method to get events that should have their lobby opened now
  async getEventsNeedingLobbyOpen(): Promise<Event[]> {
    const now = new Date();
    const twoMinutesFromNow = new Date(now.getTime() + 2 * 60 * 1000);
    
    return this.eventModel.find({
      isCompleted: false,
      lobbyOpen: false,
      startDate: {
        $gte: new Date(twoMinutesFromNow.getTime() - 30 * 1000), // 30 seconds buffer
        $lte: new Date(twoMinutesFromNow.getTime() + 30 * 1000)  // 30 seconds buffer
      }
    }).exec();
  }

  // Method to manually trigger event creation (for testing)
  async manuallyCreateNextEvent(): Promise<Event> {
    const startDate = new Date(Date.now() + 15 * 60 * 1000);
    const theme = `Manual Event - ${startDate.toLocaleTimeString()}`;
    
    const event = await this.createEvent(theme, startDate, 5, 2);
    console.log(`✅ Manually created event: ${theme} at ${startDate}`);
    
    return event;
  }
}