import 'reflect-metadata';

import * as crypto from 'crypto';
import { TransactionConfig, TransactionContext } from './transaction';
import { WorkflowConfig, WorkflowContext } from './workflow';
import { DBOSContext, DBOSContextImpl, getCurrentDBOSContext } from './context';
import { StepConfig, StepContext } from './step';
import { DBOSConflictingRegistrationError, DBOSNotAuthorizedError } from './error';
import { validateMethodArgs } from './data_validation';
import { StoredProcedureConfig, StoredProcedureContext } from './procedure';
import { DBOSEventReceiver } from './eventreceiver';
import { InitContext } from './dbos';

/**
 * Any column type column can be.
 */
export type DBOSFieldType =
  | 'integer'
  | 'double'
  | 'decimal'
  | 'timestamp'
  | 'text'
  | 'varchar'
  | 'boolean'
  | 'uuid'
  | 'json';

export class DBOSDataType {
  dataType: DBOSFieldType = 'text';
  length: number = -1;
  precision: number = -1;
  scale: number = -1;

  /** Varchar has length */
  static varchar(length: number) {
    const dt = new DBOSDataType();
    dt.dataType = 'varchar';
    dt.length = length;
    return dt;
  }

  /** Some decimal has precision / scale (as opposed to floating point decimal) */
  static decimal(precision: number, scale: number) {
    const dt = new DBOSDataType();
    dt.dataType = 'decimal';
    dt.precision = precision;
    dt.scale = scale;

    return dt;
  }

  /** Take type from reflect metadata */
  // eslint-disable-next-line @typescript-eslint/no-unsafe-function-type
  static fromArg(arg?: Function): DBOSDataType | undefined {
    if (!arg) return undefined;

    const dt = new DBOSDataType();

    if (arg === String) {
      dt.dataType = 'text';
    } else if (arg === Date) {
      dt.dataType = 'timestamp';
    } else if (arg === Number) {
      dt.dataType = 'double';
    } else if (arg === Boolean) {
      dt.dataType = 'boolean';
    } else {
      dt.dataType = 'json';
    }

    return dt;
  }

  formatAsString(): string {
    let rv: string = this.dataType;
    if (this.dataType === 'varchar' && this.length > 0) {
      rv += `(${this.length})`;
    }
    if (this.dataType === 'decimal' && this.precision > 0) {
      if (this.scale > 0) {
        rv += `(${this.precision},${this.scale})`;
      } else {
        rv += `(${this.precision})`;
      }
    }
    return rv;
  }
}

// eslint-disable-next-line @typescript-eslint/no-unsafe-function-type
function getArgNames(func: Function): string[] {
  const fstr = func.toString();
  const args: string[] = [];
  let currentArgName = '';
  let nestDepth = 0;
  let inSingleQuote = false;
  let inDoubleQuote = false;
  let inBacktick = false;
  let inComment = false;
  let inBlockComment = false;
  let inDefaultValue = false;

  // Extract parameter list from function signature
  const paramStart = fstr.indexOf('(');
  if (paramStart === -1) return [];

  const paramStr = fstr.substring(paramStart + 1);

  for (let i = 0; i < paramStr.length; i++) {
    const char = paramStr[i];
    const nextChar = paramStr[i + 1];

    // Handle comments
    if (inBlockComment) {
      if (char === '*' && nextChar === '/') {
        inBlockComment = false;
        i++; // Skip closing '/'
      }
      continue;
    } else if (inComment) {
      if (char === '\n') inComment = false;
      continue;
    } else if (char === '/' && nextChar === '*') {
      inBlockComment = true;
      i++;
      continue;
    } else if (char === '/' && nextChar === '/') {
      inComment = true;
      continue;
    }
    if (inComment || inBlockComment) continue;

    // Handle quotes (for default values)
    if (char === "'" && !inDoubleQuote && !inBacktick) {
      inSingleQuote = !inSingleQuote;
    } else if (char === '"' && !inSingleQuote && !inBacktick) {
      inDoubleQuote = !inDoubleQuote;
    } else if (char === '`' && !inSingleQuote && !inDoubleQuote) {
      inBacktick = !inBacktick;
    }

    // Skip anything inside quotes
    if (inSingleQuote || inDoubleQuote || inBacktick) {
      continue;
    }

    // Handle default values
    if (char === '=' && nestDepth === 0) {
      inDefaultValue = true;
      continue;
    }

    // These can mean default values.  Or destructuring (which is a problem)...
    if (char === '(' || char === '{' || char === '[') {
      nestDepth++;
    }
    if (char === ')' || char === '}' || char === ']') {
      if (nestDepth === 0) break; // Done
      nestDepth--;
    }

    // Handle rest parameters `...arg`; this is a problem.
    if (char === '.' && nextChar === '.' && paramStr[i + 2] === '.') {
      i += 2; // Skip the other dots
      continue;
    }

    // Handle argument separators (`,`) at depth 0
    if (char === ',' && nestDepth === 0) {
      if (currentArgName.trim()) {
        args.push(currentArgName.trim());
      }
      currentArgName = '';
      inDefaultValue = false;
      continue;
    }

    // Add valid characters to the current argument
    if (!inDefaultValue) {
      currentArgName += char;
    }
  }

  // Push the last argument if it exists
  if (currentArgName.trim()) {
    if (currentArgName.trim()) {
      args.push(currentArgName.trim());
    }
  }

  return args;
}

export enum LogMasks {
  NONE = 'NONE',
  HASH = 'HASH',
  SKIP = 'SKIP',
}

export enum ArgRequiredOptions {
  REQUIRED = 'REQUIRED',
  OPTIONAL = 'OPTIONAL',
  DEFAULT = 'DEFAULT',
}

export class MethodParameter {
  name: string = '';
  required: ArgRequiredOptions = ArgRequiredOptions.DEFAULT;
  validate: boolean = true;
  logMask: LogMasks = LogMasks.NONE;

  // eslint-disable-next-line @typescript-eslint/no-unsafe-function-type
  argType?: Function = undefined; // This comes from reflect-metadata, if we have it
  dataType?: DBOSDataType;
  index: number = -1;

  // eslint-disable-next-line @typescript-eslint/no-unsafe-function-type
  constructor(idx: number, at?: Function) {
    this.index = idx;
    this.argType = at;
    this.dataType = DBOSDataType.fromArg(at);
  }
}

//////////////////////////////////////////
/* REGISTRATION OBJECTS and read access */
//////////////////////////////////////////

export interface RegistrationDefaults {
  name: string;
  requiredRole: string[] | undefined;
  argRequiredEnabled: boolean;
  defaultArgRequired: ArgRequiredOptions;
  defaultArgValidate: boolean;
  eventReceiverInfo: Map<DBOSEventReceiver, unknown>;
}

export interface MethodRegistrationBase {
  name: string;
  className: string;

  args: MethodParameter[];
  performArgValidation: boolean;

  defaults?: RegistrationDefaults;

  getRequiredRoles(): string[];

  workflowConfig?: WorkflowConfig;
  txnConfig?: TransactionConfig;
  stepConfig?: StepConfig;
  procConfig?: TransactionConfig;
  isInstance: boolean;

  eventReceiverInfo: Map<DBOSEventReceiver, unknown>;

  // eslint-disable-next-line @typescript-eslint/no-unsafe-function-type
  wrappedFunction: Function | undefined; // Function that is user-callable, including the WF engine transition
  // eslint-disable-next-line @typescript-eslint/no-unsafe-function-type
  registeredFunction: Function | undefined; // Function that is called by DBOS engine, including input validation and role check
  // eslint-disable-next-line @typescript-eslint/no-unsafe-function-type
  origFunction: Function; // Function that the app provided
  // Pass context as first arg?
  readonly passContext: boolean;

  invoke(pthis: unknown, args: unknown[]): unknown;
}

export class MethodRegistration<This, Args extends unknown[], Return> implements MethodRegistrationBase {
  defaults?: RegistrationDefaults | undefined;

  name: string = '';
  className: string = '';

  requiredRole: string[] | undefined = undefined;

  performArgValidation: boolean = false;
  args: MethodParameter[] = [];
  passContext: boolean = false;

  constructor(origFunc: (this: This, ...args: Args) => Promise<Return>, isInstance: boolean, passContext: boolean) {
    this.origFunction = origFunc;
    this.isInstance = isInstance;
    this.passContext = passContext;
  }

  needInitialized: boolean = true;
  isInstance: boolean;
  origFunction: (this: This, ...args: Args) => Promise<Return>;
  registeredFunction: ((this: This, ...args: Args) => Promise<Return>) | undefined;
  wrappedFunction: ((this: This, ...args: Args) => Promise<Return>) | undefined = undefined;
  workflowConfig?: WorkflowConfig;
  txnConfig?: TransactionConfig;
  stepConfig?: StepConfig;
  procConfig?: TransactionConfig;
  regLocation?: string[];
  eventReceiverInfo: Map<DBOSEventReceiver, unknown> = new Map();

  getAssignedType(): 'Transaction' | 'Workflow' | 'Step' | 'Procedure' | undefined {
    if (this.txnConfig) return 'Transaction';
    if (this.workflowConfig) return 'Workflow';
    if (this.stepConfig) return 'Step';
    if (this.procConfig) return 'Procedure';
    return undefined;
  }

  checkFuncTypeUnassigned(newType: string) {
    const oldType = this.getAssignedType();
    let error: string | undefined = undefined;
    if (oldType && newType !== oldType) {
      error = `Operation (Name: ${this.className}.${this.name}) is already registered with a conflicting function type: ${oldType} vs. ${newType}`;
    } else if (oldType) {
      error = `Operation (Name: ${this.className}.${this.name}) is already registered.`;
    }
    if (error) {
      if (this.regLocation) {
        error = error + `\nPrior registration occurred at:\n${this.regLocation.join('\n')}`;
      }
      throw new DBOSConflictingRegistrationError(`${error}`);
    } else {
      this.regLocation = new StackGrabber().getCleanStack(3);
    }
  }

  setTxnConfig(txCfg: TransactionConfig): void {
    this.checkFuncTypeUnassigned('Transaction');
    this.txnConfig = txCfg;
  }

  setStepConfig(stepCfg: StepConfig): void {
    this.checkFuncTypeUnassigned('Step');
    this.stepConfig = stepCfg;
  }

  setProcConfig(procCfg: TransactionConfig): void {
    this.checkFuncTypeUnassigned('Procedure');
    this.procConfig = procCfg;
  }

  setWorkflowConfig(wfCfg: WorkflowConfig): void {
    this.checkFuncTypeUnassigned('Workflow');
    this.workflowConfig = wfCfg;
  }

  init: boolean = false;

  invoke(pthis: This, args: Args): Promise<Return> {
    return this.registeredFunction!.call(pthis, ...args);
  }

  getRequiredRoles() {
    if (this.requiredRole) {
      return this.requiredRole;
    }
    return this.defaults?.requiredRole || [];
  }
}

function registerClassInstance(inst: ConfiguredInstance, name: string) {
  const creg = getOrCreateClassRegistration(inst.constructor as AnyConstructor);
  if (creg.configuredInstances.has(name)) {
    throw new DBOSConflictingRegistrationError(
      `An instance of class '${inst.constructor.name}' with name '${name}' was already registered.  Earlier registration occurred at:\n${(creg.configuredInstanceRegLocs.get(name) ?? []).join('\n')}`,
    );
  }
  creg.configuredInstances.set(name, inst);
  creg.configuredInstanceRegLocs.set(name, new StackGrabber().getCleanStack(3) ?? []);
}

export abstract class ConfiguredInstance {
  readonly name: string;
  constructor(name: string) {
    if (dbosLaunchPoint) {
      console.warn(
        `ConfiguredInstance '${name}' is being created after DBOS initialization and was not available for recovery.`,
      );
    }
    this.name = name;
    registerClassInstance(this, name);
  }
  /**
   * Override this method to perform async initialization.
   * @param _ctx - @deprecated This parameter is unnecessary, use `DBOS` instead.
   */
  initialize(_ctx: InitContext): Promise<void> {
    return Promise.resolve();
  }
}

export class ClassRegistration<CT extends { new (...args: unknown[]): object }> implements RegistrationDefaults {
  name: string = '';
  requiredRole: string[] | undefined;
  argRequiredEnabled: boolean = false;
  defaultArgRequired: ArgRequiredOptions = ArgRequiredOptions.REQUIRED;
  defaultArgValidate: boolean = false;
  needsInitialized: boolean = true;

  // eslint-disable-next-line @typescript-eslint/no-unsafe-function-type
  ormEntities: Function[] | { [key: string]: object } = [];

  registeredOperations: Map<string, MethodRegistrationBase> = new Map();

  configuredInstances: Map<string, ConfiguredInstance> = new Map();
  configuredInstanceRegLocs: Map<string, string[]> = new Map();

  eventReceiverInfo: Map<DBOSEventReceiver, unknown> = new Map();

  ctor: CT;
  constructor(ctor: CT) {
    this.ctor = ctor;
  }
}

class StackGrabber extends Error {
  constructor() {
    super('StackGrabber');
    Error.captureStackTrace(this, StackGrabber); // Excludes constructor from the stack
  }

  getCleanStack(frames: number = 1) {
    return this.stack
      ?.split('\n')
      .slice(frames + 1)
      .map((l) => '>>> ' + l.replace(/^\s*at\s*/, '')); // Remove the first lines
  }
}

let dbosLaunchPoint: string[] | undefined = undefined;
export function recordDBOSLaunch() {
  dbosLaunchPoint = new StackGrabber().getCleanStack(2); // Remove one for record, one for registerAndWrap...
}
export function recordDBOSShutdown() {
  dbosLaunchPoint = undefined;
}

export function ensureDBOSIsNotLaunched() {
  if (dbosLaunchPoint) {
    throw new DBOSConflictingRegistrationError(
      `DBOS code is being registered after DBOS.launch().  DBOS was launched from:\n${dbosLaunchPoint.join('\n')}\n`,
    );
  }
}

// This is a bit ugly, if we got the class / instance it would help avoid this auxiliary structure
const methodToRegistration: Map<unknown, MethodRegistration<unknown, unknown[], unknown>> = new Map();
export function getRegisteredMethodClassName(func: unknown): string {
  let rv: string = '';
  if (methodToRegistration.has(func)) {
    rv = methodToRegistration.get(func)!.className;
  }
  return rv;
}
export function getRegisteredMethodName(func: unknown): string {
  let rv: string = '';
  if (methodToRegistration.has(func)) {
    rv = methodToRegistration.get(func)!.name;
  }
  return rv;
}
export function registerFunctionWrapper(func: unknown, reg: MethodRegistration<unknown, unknown[], unknown>) {
  methodToRegistration.set(func, reg);
}

export function getRegisteredOperations(target: object): ReadonlyArray<MethodRegistrationBase> {
  const registeredOperations: MethodRegistrationBase[] = [];

  if (typeof target === 'function') {
    // Constructor case
    const classReg = classesByName.get(target.name);
    classReg?.registeredOperations?.forEach((m) => registeredOperations.push(m));
  } else {
    let current: object | undefined = target;
    while (current) {
      const cname = current.constructor.name;
      if (classesByName.has(cname)) {
        registeredOperations.push(...getRegisteredOperations(current.constructor));
      }
      current = Object.getPrototypeOf(current) as object | undefined;
    }
  }

  return registeredOperations;
}

export function getConfiguredInstance(clsname: string, cfgname: string): ConfiguredInstance | null {
  const classReg = classesByName.get(clsname);
  if (!classReg) return null;
  return classReg.configuredInstances.get(cfgname) ?? null;
}

////////////////////////////////////////////////////////////////////////////////
// DECORATOR REGISTRATION
// These manage registration objects, creating them at decorator evaluation time
// and making wrapped methods available for function registration at runtime
// initialization time.
////////////////////////////////////////////////////////////////////////////////

const methodArgsByFunction: Map<string, MethodParameter[]> = new Map();

export function getOrCreateMethodArgsRegistration(target: object, propertyKey: string | symbol): MethodParameter[] {
  let regtarget = target;
  if (typeof regtarget !== 'function') {
    regtarget = regtarget.constructor;
  }

  // eslint-disable-next-line @typescript-eslint/no-unsafe-function-type
  const mkey = (regtarget as Function).name + '|' + propertyKey.toString();

  let mParameters: MethodParameter[] | undefined = methodArgsByFunction.get(mkey);
  if (mParameters === undefined) {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-function-type
    const designParamTypes = Reflect.getMetadata('design:paramtypes', target, propertyKey) as Function[] | undefined;
    if (designParamTypes) {
      mParameters = designParamTypes.map((value, index) => new MethodParameter(index, value));
    } else {
      const descriptor = Object.getOwnPropertyDescriptor(target, propertyKey);
      // eslint-disable-next-line @typescript-eslint/no-unsafe-function-type
      const argnames = getArgNames(descriptor?.value as Function);
      mParameters = argnames.map((_value, index) => new MethodParameter(index));
    }

    methodArgsByFunction.set(mkey, mParameters);
  }

  return mParameters;
}

function generateSaltedHash(data: string, salt: string): string {
  const hash = crypto.createHash('sha256'); // You can use other algorithms like 'md5', 'sha512', etc.
  hash.update(data + salt);
  return hash.digest('hex');
}

function getOrCreateMethodRegistration<This, Args extends unknown[], Return>(
  target: object,
  propertyKey: string | symbol,
  descriptor: TypedPropertyDescriptor<(this: This, ...args: Args) => Promise<Return>>,
  passContext: boolean,
) {
  let regtarget: AnyConstructor;
  let isInstance = false;
  if (typeof target === 'function') {
    // Static method case
    regtarget = target as AnyConstructor;
  } else {
    // Instance method case
    regtarget = target.constructor as AnyConstructor;
    isInstance = true;
  }

  const classReg = getOrCreateClassRegistration(regtarget);

  const fname = propertyKey.toString();
  if (!classReg.registeredOperations.has(fname)) {
    classReg.registeredOperations.set(
      fname,
      new MethodRegistration<This, Args, Return>(descriptor.value!, isInstance, passContext),
    );
  }
  const methReg: MethodRegistration<This, Args, Return> = classReg.registeredOperations.get(
    fname,
  )! as MethodRegistration<This, Args, Return>;

  // Note: We cannot tell if the method takes a context or not.
  //  Our @Workflow, @Transaction, and @Step decorators are the only ones that would know to set passContext.
  // So, if passContext is indicated, add it to the registration.
  if (passContext && !methReg.passContext) {
    methReg.passContext = true;
  }

  if (methReg.needInitialized) {
    methReg.needInitialized = false;
    methReg.name = fname;
    methReg.className = classReg.name;
    methReg.defaults = classReg;

    methReg.args = getOrCreateMethodArgsRegistration(target, propertyKey);

    const argNames = getArgNames(descriptor.value!);
    methReg.args.forEach((e) => {
      if (e.required !== ArgRequiredOptions.DEFAULT) {
        classReg.argRequiredEnabled = true;
      }
      if (!e.name) {
        if (e.index < argNames.length) {
          e.name = argNames[e.index];
        }
        if (e.index === 0 && passContext) {
          // The first argument is always the context.
          e.logMask = LogMasks.SKIP;
        }
        // TODO else warn/log something
      }
    });

    const wrappedMethod = async function (this: This, ...rawArgs: Args) {
      let opCtx: DBOSContextImpl | undefined = undefined;
      if (passContext) {
        opCtx = rawArgs[0] as DBOSContextImpl;
      } else {
        opCtx = getCurrentDBOSContext() as DBOSContextImpl;
      }

      // Validate the user authentication and populate the role field
      const requiredRoles = methReg.getRequiredRoles();
      if (requiredRoles.length > 0) {
        opCtx.span.setAttribute('requiredRoles', requiredRoles);
        const curRoles = opCtx.authenticatedRoles;
        let authorized = false;
        const set = new Set(curRoles);
        for (const role of requiredRoles) {
          if (set.has(role)) {
            authorized = true;
            opCtx.assumedRole = role;
            break;
          }
        }
        if (!authorized) {
          const err = new DBOSNotAuthorizedError(
            `User does not have a role with permission to call ${methReg.name}`,
            403,
          );
          opCtx.span.addEvent('DBOSNotAuthorizedError', { message: err.message });
          throw err;
        }
      }

      const validatedArgs = validateMethodArgs(methReg, rawArgs);

      // Argument logging
      validatedArgs.forEach((argValue, idx) => {
        let isCtx = false;
        // TODO: we assume the first argument is always a context, need a more robust way to test it.
        if (idx === 0 && passContext) {
          // Context -- I suppose we could just instanceof
          opCtx = validatedArgs[0] as DBOSContextImpl;
          isCtx = true;
        }

        let loggedArgValue = argValue;
        if (isCtx || methReg.args[idx].logMask === LogMasks.SKIP) {
          return;
        } else {
          if (methReg.args[idx].logMask !== LogMasks.NONE) {
            // For now this means hash
            if (methReg.args[idx].dataType?.dataType === 'json') {
              loggedArgValue = generateSaltedHash(JSON.stringify(argValue), 'JSONSALT');
            } else {
              // Yes, we are doing the same as above for now.
              // It can be better if we have verified the type of the data
              loggedArgValue = generateSaltedHash(JSON.stringify(argValue), 'DBOSSALT');
            }
          }
          opCtx?.span.setAttribute(methReg.args[idx].name, loggedArgValue as string);
        }
      });

      return methReg.origFunction.call(this, ...validatedArgs);
    };
    Object.defineProperty(wrappedMethod, 'name', {
      value: methReg.name,
    });

    descriptor.value = wrappedMethod;
    methReg.registeredFunction = wrappedMethod;

    methodToRegistration.set(methReg.registeredFunction, methReg as MethodRegistration<unknown, unknown[], unknown>);
    methodToRegistration.set(methReg.origFunction, methReg as MethodRegistration<unknown, unknown[], unknown>);
  }

  return methReg;
}

export function registerAndWrapFunctionTakingContext<This, Args extends unknown[], Return>(
  target: object,
  propertyKey: string,
  descriptor: TypedPropertyDescriptor<(this: This, ...args: Args) => Promise<Return>>,
) {
  ensureDBOSIsNotLaunched();
  if (!descriptor.value) {
    throw Error('Use of decorator when original method is undefined');
  }

  const registration = getOrCreateMethodRegistration(target, propertyKey, descriptor, true);

  return { descriptor, registration };
}

export function registerAndWrapDBOSFunction<This, Args extends unknown[], Return>(
  target: object,
  propertyKey: string,
  descriptor: TypedPropertyDescriptor<(this: This, ...args: Args) => Promise<Return>>,
) {
  ensureDBOSIsNotLaunched();
  if (!descriptor.value) {
    throw Error('Use of decorator when original method is undefined');
  }

  const registration = getOrCreateMethodRegistration(target, propertyKey, descriptor, false);

  return { descriptor, registration };
}

type AnyConstructor = new (...args: unknown[]) => object;
const classesByName: Map<string, ClassRegistration<AnyConstructor>> = new Map();

export function getAllRegisteredClasses() {
  const ctors: AnyConstructor[] = [];
  for (const [_cn, creg] of classesByName) {
    ctors.push(creg.ctor);
  }
  return ctors;
}

export function getOrCreateClassRegistration<CT extends { new (...args: unknown[]): object }>(ctor: CT) {
  const name = ctor.name;
  if (!classesByName.has(name)) {
    classesByName.set(name, new ClassRegistration<CT>(ctor));
  }
  const clsReg: ClassRegistration<AnyConstructor> = classesByName.get(name)!;

  if (clsReg.needsInitialized) {
    clsReg.name = name;
    clsReg.needsInitialized = false;
  }
  return clsReg;
}

/**
 * Associates a class with a `DBOSEventReceiver`, which will be calling the class's DBOS methods.
 * Allows class-level default values or other storage to be associated with the class, rather than
 *   separately for each registered method.
 *
 * @param rcvr - Event receiver which will dispatch DBOS methods from the class specified by `ctor`
 * @param ctor - Constructor of the class that is being registered and associated with `rcvr`
 * @returns - Class-specific registration info cumulatively collected for `rcvr`
 */
export function associateClassWithEventReceiver<CT extends { new (...args: unknown[]): object }>(
  rcvr: DBOSEventReceiver,
  ctor: CT,
) {
  const clsReg = getOrCreateClassRegistration(ctor);
  if (!clsReg.eventReceiverInfo.has(rcvr)) {
    clsReg.eventReceiverInfo.set(rcvr, {});
  }
  return clsReg.eventReceiverInfo.get(rcvr)!;
}

/**
 * Associates a workflow method with a `DBOSEventReceiver` which will be in charge of calling the method
 *   in response to received events.
 * This version is to be used in "Stage 2" decorators, as it applies the DBOS wrapper to the registered method.
 *
 * @param rcvr - `DBOSEventReceiver` instance that should be informed of the `target` method's registration
 * @param target - A DBOS method to associate with the event receiver
 * @param propertyKey - For Stage 2 decorator use, this is the property key used for replacing the method with its wrapper
 * @param inDescriptor - For Stage 2 decorator use, this is the method descriptor used for replacing the method with its wrapper
 * @returns The new method descriptor, registration, and event receiver info
 */
export function associateMethodWithEventReceiver<This, Args extends unknown[], Return>(
  rcvr: DBOSEventReceiver,
  target: object,
  propertyKey: string,
  inDescriptor: TypedPropertyDescriptor<(this: This, ...args: Args) => Promise<Return>>,
) {
  const { descriptor, registration } = registerAndWrapDBOSFunction(target, propertyKey, inDescriptor);
  if (!registration.eventReceiverInfo.has(rcvr)) {
    registration.eventReceiverInfo.set(rcvr, {});
  }
  return { descriptor, registration, receiverInfo: registration.eventReceiverInfo.get(rcvr)! };
}

//////////////////////////
/* PARAMETER DECORATORS */
//////////////////////////

export function ArgRequired(target: object, propertyKey: string | symbol, parameterIndex: number) {
  const existingParameters = getOrCreateMethodArgsRegistration(target, propertyKey);

  const curParam = existingParameters[parameterIndex];
  curParam.required = ArgRequiredOptions.REQUIRED;
}

export function ArgOptional(target: object, propertyKey: string | symbol, parameterIndex: number) {
  const existingParameters = getOrCreateMethodArgsRegistration(target, propertyKey);

  const curParam = existingParameters[parameterIndex];
  curParam.required = ArgRequiredOptions.OPTIONAL;
}

export function SkipLogging(target: object, propertyKey: string | symbol, parameterIndex: number) {
  const existingParameters = getOrCreateMethodArgsRegistration(target, propertyKey);

  const curParam = existingParameters[parameterIndex];
  curParam.logMask = LogMasks.SKIP;
}

export function LogMask(mask: LogMasks) {
  return function (target: object, propertyKey: string | symbol, parameterIndex: number) {
    const existingParameters = getOrCreateMethodArgsRegistration(target, propertyKey);

    const curParam = existingParameters[parameterIndex];
    curParam.logMask = mask;
  };
}

export function ArgName(name: string) {
  return function (target: object, propertyKey: string | symbol, parameterIndex: number) {
    const existingParameters = getOrCreateMethodArgsRegistration(target, propertyKey);

    const curParam = existingParameters[parameterIndex];
    curParam.name = name;
  };
}

export function ArgDate() {
  // TODO a little more info about it - is it a date or timestamp precision?
  return function (target: object, propertyKey: string | symbol, parameterIndex: number) {
    const existingParameters = getOrCreateMethodArgsRegistration(target, propertyKey);

    const curParam = existingParameters[parameterIndex];
    if (!curParam.dataType) curParam.dataType = new DBOSDataType();
    curParam.dataType.dataType = 'timestamp';
  };
}

export function ArgVarchar(length: number) {
  return function (target: object, propertyKey: string | symbol, parameterIndex: number) {
    const existingParameters = getOrCreateMethodArgsRegistration(target, propertyKey);

    const curParam = existingParameters[parameterIndex];
    curParam.dataType = DBOSDataType.varchar(length);
  };
}

///////////////////////
/* CLASS DECORATORS */
///////////////////////

export function DefaultRequiredRole(anyOf: string[]) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function clsdec<T extends { new (...args: any[]): object }>(ctor: T) {
    const clsreg = getOrCreateClassRegistration(ctor);
    clsreg.requiredRole = anyOf;
  }
  return clsdec;
}

export function DefaultArgRequired<T extends { new (...args: unknown[]): object }>(ctor: T) {
  const clsreg = getOrCreateClassRegistration(ctor);
  clsreg.defaultArgRequired = ArgRequiredOptions.REQUIRED;
  clsreg.argRequiredEnabled = true;
}

export function DefaultArgValidate<T extends { new (...args: unknown[]): object }>(ctor: T) {
  const clsreg = getOrCreateClassRegistration(ctor);
  clsreg.defaultArgValidate = true;
}

export function DefaultArgOptional<T extends { new (...args: unknown[]): object }>(ctor: T) {
  const clsreg = getOrCreateClassRegistration(ctor);
  clsreg.defaultArgRequired = ArgRequiredOptions.OPTIONAL;
  clsreg.argRequiredEnabled = true;
}

/** @deprecated Use `new` */
export function configureInstance<R extends ConfiguredInstance, T extends unknown[]>(
  cls: new (name: string, ...args: T) => R,
  name: string,
  ...args: T
): R {
  const inst = new cls(name, ...args);
  return inst;
}

///////////////////////
/* METHOD DECORATORS */
///////////////////////

/** @see `DBOS.requiredRole` */
export function RequiredRole(anyOf: string[]) {
  function apidec<This, Ctx extends DBOSContext, Args extends unknown[], Return>(
    target: object,
    propertyKey: string,
    inDescriptor: TypedPropertyDescriptor<(this: This, ctx: Ctx, ...args: Args) => Promise<Return>>,
  ) {
    const { descriptor, registration } = registerAndWrapDBOSFunction(target, propertyKey, inDescriptor);
    registration.requiredRole = anyOf;

    return descriptor;
  }
  return apidec;
}

/**
 * @deprecated Use `@DBOS.workflow`
 * To upgrade to DBOS 2.0+ syntax:
 *   Use `@DBOS.workflow` to decorate the method
 *   Remove the `WorkflowContext` parameter
 *   Use `DBOS` instead of the context to access DBOS functions
 *   Change all callers of the decorated function to call the function directly, or with `DBOS.startWorkflow`
 */
export function Workflow(config: WorkflowConfig = {}) {
  function decorator<This, Args extends unknown[], Return>(
    target: object,
    propertyKey: string,
    inDescriptor: TypedPropertyDescriptor<(this: This, ctx: WorkflowContext, ...args: Args) => Promise<Return>>,
  ) {
    const { descriptor, registration } = registerAndWrapFunctionTakingContext(target, propertyKey, inDescriptor);
    registration.setWorkflowConfig(config);
    return descriptor;
  }
  return decorator;
}

/**
 * @deprecated Use `@DBOS.transaction`
 * To upgrade to DBOS 2.0+ syntax:
 *   Use `@DBOS.transaction` to decorate the method
 *   Remove the `TransactionContext` parameter
 *   Use `DBOS` instead of the context to access DBOS functions
 *   Change all callers to call the decorated function directly
 */
export function Transaction(config: TransactionConfig = {}) {
  function decorator<This, Args extends unknown[], Return>(
    target: object,
    propertyKey: string,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    inDescriptor: TypedPropertyDescriptor<(this: This, ctx: TransactionContext<any>, ...args: Args) => Promise<Return>>,
  ) {
    const { descriptor, registration } = registerAndWrapFunctionTakingContext(target, propertyKey, inDescriptor);
    registration.setTxnConfig(config);
    return descriptor;
  }
  return decorator;
}

/**
 * @deprecated Use `@DBOS.storedProcedure`
 * To upgrade to DBOS 2.0+ syntax:
 *   Use `@DBOS.storedProcedure` to decorate the method
 *   Remove the context parameter and use `DBOS` instead of the context to access DBOS functions
 *   Change all callers to call the decorated function directly
 */
export function StoredProcedure(config: StoredProcedureConfig = {}) {
  function decorator<This, Args extends unknown[], Return>(
    target: object,
    propertyKey: string,
    inDescriptor: TypedPropertyDescriptor<(this: This, ctx: StoredProcedureContext, ...args: Args) => Promise<Return>>,
  ) {
    const { descriptor, registration } = registerAndWrapFunctionTakingContext(target, propertyKey, inDescriptor);
    registration.setProcConfig(config);
    return descriptor;
  }
  return decorator;
}

/**
 * @deprecated Use `@DBOS.step`
 * To upgrade to DBOS 2.0+ syntax:
 *   Use `@DBOS.step` to decorate the method
 *   Remove the `StepContext` parameter
 *   Use `DBOS` instead of the context to access DBOS functions
 *   Change all callers to call the decorated function directly
 */
export function Step(config: StepConfig = {}) {
  function decorator<This, Args extends unknown[], Return>(
    target: object,
    propertyKey: string,
    inDescriptor: TypedPropertyDescriptor<(this: This, ctx: StepContext, ...args: Args) => Promise<Return>>,
  ) {
    const { descriptor, registration } = registerAndWrapFunctionTakingContext(target, propertyKey, inDescriptor);
    registration.setStepConfig(config);
    return descriptor;
  }
  return decorator;
}

// eslint-disable-next-line @typescript-eslint/no-unsafe-function-type
export function OrmEntities(entities: Function[] | { [key: string]: object } = []) {
  function clsdec<T extends { new (...args: unknown[]): object }>(ctor: T) {
    const clsreg = getOrCreateClassRegistration(ctor);
    clsreg.ormEntities = entities;
  }
  return clsdec;
}

export function DBOSInitializer() {
  function decorator<This, Args extends unknown[], Return>(
    target: object,
    propertyKey: string,
    inDescriptor: TypedPropertyDescriptor<(this: This, ...args: Args) => Promise<Return>>,
  ) {
    const { descriptor, registration } = registerAndWrapDBOSFunction(target, propertyKey, inDescriptor);
    registration.init = true;
    return descriptor;
  }
  return decorator;
}

/** @deprecated */
export function DBOSDeploy() {
  function decorator<This, Args extends unknown[], Return>(
    target: object,
    propertyKey: string,
    inDescriptor: TypedPropertyDescriptor<(this: This, ctx: InitContext, ...args: Args) => Promise<Return>>,
  ) {
    const { descriptor, registration } = registerAndWrapFunctionTakingContext(target, propertyKey, inDescriptor);
    registration.init = true;
    return descriptor;
  }
  return decorator;
}
