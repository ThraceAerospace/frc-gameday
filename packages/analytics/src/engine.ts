import type { FieldViewAnalyticsDefinition } from "../../domain/src/analytics.ts";

export type AnalyticsOperation<TContext = any, TResult = any> = {
  operation_key: string;
  execute(context: TContext, inputs: Readonly<Record<string, unknown>>): TResult | Promise<TResult>;
};

export type AnalyticsExecutionInput<TContext> = {
  definition_key: string;
  context: TContext;
  /** Values resolved by the owning runtime; source_path is descriptive, never executable. */
  resolved_inputs: Readonly<Record<string, unknown>>;
};

export type AnalyticsExecutionResult<TResult> = {
  definition_key: string;
  definition_version: string;
  operation_key: string;
  status: "succeeded";
  value: TResult;
  warnings: string[];
};

export class AnalyticsExecutionError extends Error {
  readonly code: "unknown-definition" | "unknown-operation" | "missing-required-input" | "duplicate-operation";
  constructor(code: AnalyticsExecutionError["code"], message: string) {
    super(message);
    this.name = "AnalyticsExecutionError";
    this.code = code;
  }
}

/** Explicit allowlist. Definitions select a registered key; they cannot supply executable code. */
export class AnalyticsOperationRegistry {
  private readonly operations = new Map<string, AnalyticsOperation<any, any>>();

  constructor(operations: readonly AnalyticsOperation[] = []) {
    for (const operation of operations) this.register(operation);
  }

  register(operation: AnalyticsOperation<any, any>): void {
    if (!operation.operation_key.trim()) throw new Error("Analytics operation key must not be empty");
    if (this.operations.has(operation.operation_key)) {
      throw new AnalyticsExecutionError("duplicate-operation", "Analytics operation already registered: " + operation.operation_key);
    }
    this.operations.set(operation.operation_key, operation);
  }

  get(operationKey: string): AnalyticsOperation<any, any> | undefined {
    return this.operations.get(operationKey);
  }

  keys(): string[] {
    return [...this.operations.keys()].sort();
  }
}

export class AnalyticsEngine {
  private readonly definitions: ReadonlyMap<string, FieldViewAnalyticsDefinition>;
  constructor(
    definitions: readonly FieldViewAnalyticsDefinition[],
    private readonly registry: AnalyticsOperationRegistry,
  ) {
    const indexed = new Map<string, FieldViewAnalyticsDefinition>();
    for (const definition of definitions) {
      if (!definition.definition_key.trim() || !definition.version.trim()) {
        throw new Error("Analytics definitions require a key and version");
      }
      if (indexed.has(definition.definition_key)) {
        throw new Error("Duplicate analytics definition: " + definition.definition_key);
      }
      if (!registry.get(definition.operation_key)) {
        throw new AnalyticsExecutionError("unknown-operation", "No registered analytics operation: " + definition.operation_key);
      }
      const inputKeys = new Set<string>();
      for (const input of definition.inputs) {
        if (!input.input_key.trim() || inputKeys.has(input.input_key)) {
          throw new Error("Invalid or duplicate input key in definition " + definition.definition_key);
        }
        inputKeys.add(input.input_key);
      }
      indexed.set(definition.definition_key, definition);
    }
    this.definitions = indexed;
  }

  async execute<TContext = any, TResult = any>(
    input: AnalyticsExecutionInput<TContext>,
  ): Promise<AnalyticsExecutionResult<TResult>> {
    const definition = this.definitions.get(input.definition_key);
    if (!definition) {
      throw new AnalyticsExecutionError("unknown-definition", "Unknown analytics definition: " + input.definition_key);
    }
    const operation = this.registry.get(definition.operation_key);
    if (!operation) {
      throw new AnalyticsExecutionError("unknown-operation", "No registered analytics operation: " + definition.operation_key);
    }

    const warnings: string[] = [];
    const resolved: Record<string, unknown> = {};
    for (const descriptor of definition.inputs) {
      const value = input.resolved_inputs[descriptor.input_key];
      if (value === undefined || value === null) {
        if (descriptor.required) {
          throw new AnalyticsExecutionError(
            "missing-required-input",
            "Missing required analytics input '" + descriptor.input_key + "' for " + definition.definition_key,
          );
        }
        warnings.push("Optional input unavailable: " + descriptor.input_key);
        continue;
      }
      resolved[descriptor.input_key] = value;
    }

    const value = await operation.execute(input.context, Object.freeze(resolved)) as TResult;
    return {
      definition_key: definition.definition_key,
      definition_version: definition.version,
      operation_key: definition.operation_key,
      status: "succeeded",
      value,
      warnings,
    };
  }
}
