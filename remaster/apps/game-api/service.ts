import { CommandResult, GameCommand, RuleError, World } from '../../packages/domain/types';
import { transition } from '../../packages/engine/engine';
import { createWorld } from '../../packages/engine/world';
import { WorldRepository } from './repository';
export class GameService {
  world: World;
  healthy=true;
  generation=1;
  queueLength=0;
  lastCommitAt=0;
  private queue:Promise<unknown>=Promise.resolve();
  onCommitted?: (world: World)=>void;
  afterCommitHook?: ()=>void;
  constructor(readonly repository: WorldRepository, seed=20261010, mode: World['mode']='sandbox') {
    this.world=repository.load()??createWorld(seed,mode);repository.initialize(this.world);
    if(this.world.mode!==mode) throw new Error('Persisted world mode differs from configured mode');
  }
  execute(command: GameCommand, key: string, expectedGeneration=this.generation): Promise<CommandResult> {
    this.queueLength++;
    const task=this.queue.then(()=>this.run(command,key,expectedGeneration));this.queue=task.catch(()=>undefined);
    return task.finally(()=>{this.queueLength--;});
  }
  private run(command: GameCommand, key: string, expectedGeneration: number): CommandResult {
    if(!this.healthy||expectedGeneration!==this.generation) throw new Error('Engine is fenced; resynchronize before writing');
    const scope='owner' in command?command.owner:'$engine';const cached=this.repository.cached(scope,key,command);if(cached) return cached;
    const previous=this.world;let next=previous;let result:CommandResult;
    try {const proposal=transition(previous,command,key);next=proposal.world;result=proposal.result;} catch(error) {
      if(!(error instanceof RuleError)) throw error;result={success:false,error:error.message,code:error.code,version:previous.version};
    }
    if(expectedGeneration!==this.generation) throw new Error('Writer generation changed');
    this.repository.commit(previous,next,scope,key,command,result);
    try {this.afterCommitHook?.();this.world=next;} catch(error) {this.healthy=false;this.generation++;this.recover();throw error;}
    this.lastCommitAt=Date.now();
    if(next!==previous) {try {this.onCommitted?.(next);} catch { /* Committed outbox remains available for reconnect. */ }}
    return result;
  }
  fence(): void {this.generation++;}
  recover(): void {const restored=this.repository.load();if(!restored) throw new Error('World snapshot missing');this.world=restored;this.healthy=true;}
}
