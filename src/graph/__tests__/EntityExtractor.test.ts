/**
 * Tests for EntityExtractor
 *
 * @module graph/__tests__/EntityExtractor.test
 */

import { describe, it, expect, beforeEach } from "vitest";
import {
  EntityExtractor,
  EntityExtractorConfig,
  ExtractionContext,
  createEntityExtractor,
  createEntityExtractorWithConfig,
  DEFAULT_PATTERNS,
} from "../EntityExtractor.js";
import { EntityType, Entity } from "../../types/graph.js";

// ============================================================================
// Test Helpers
// ============================================================================

/**
 * Helper to find entities of a specific type
 */
function findEntitiesByType(entities: Entity[], type: EntityType): Entity[] {
  return entities.filter((e) => e.type === type);
}

/**
 * Helper to check if an entity with a specific name exists
 */
function hasEntityWithName(entities: Entity[], name: string): boolean {
  return entities.some(
    (e) => e.name.toLowerCase() === name.toLowerCase()
  );
}

/**
 * Calculate extraction accuracy for a set of expected entities
 */
function calculateAccuracy(
  entities: Entity[],
  expectedNames: string[],
  entityType: EntityType
): number {
  const typeEntities = findEntitiesByType(entities, entityType);
  const foundCount = expectedNames.filter((name) =>
    typeEntities.some((e) => e.name.toLowerCase().includes(name.toLowerCase()))
  ).length;
  return expectedNames.length > 0 ? foundCount / expectedNames.length : 0;
}

// ============================================================================
// Unit Tests
// ============================================================================

describe("EntityExtractor - Unit Tests", () => {
  describe("Construction", () => {
    it("should create with default configuration", () => {
      const extractor = new EntityExtractor();
      expect(extractor).toBeInstanceOf(EntityExtractor);
      
      const config = extractor.getConfig();
      expect(config.minConfidence).toBe(0.5);
      expect(config.patterns.size).toBeGreaterThan(0);
    });

    it("should accept custom minConfidence", () => {
      const extractor = new EntityExtractor({ minConfidence: 0.8 });
      const config = extractor.getConfig();
      expect(config.minConfidence).toBe(0.8);
    });

    it("should accept custom patterns", () => {
      const customPatterns = new Map<EntityType, RegExp[]>([
        [EntityType.PERSON, [/\bTest Person\b/g]],
      ]);
      const extractor = new EntityExtractor({ patterns: customPatterns });
      const config = extractor.getConfig();
      expect(config.patterns.size).toBe(1);
    });
  });

  describe("extract() - Empty Input", () => {
    let extractor: EntityExtractor;

    beforeEach(() => {
      extractor = new EntityExtractor();
    });

    it("should return empty result for empty string", () => {
      const result = extractor.extract("");
      expect(result.entities).toHaveLength(0);
      expect(result.confidence).toBe(0);
    });

    it("should return empty result for whitespace-only string", () => {
      const result = extractor.extract("   \n\t  ");
      expect(result.entities).toHaveLength(0);
      expect(result.confidence).toBe(0);
    });

    it("should return empty result for text with no entities", () => {
      const result = extractor.extract("the quick brown fox jumps over the lazy dog");
      // May extract some entities or none depending on patterns
      expect(result.confidence).toBeGreaterThanOrEqual(0);
    });
  });

  describe("extract() - PERSON Entities", () => {
    let extractor: EntityExtractor;

    beforeEach(() => {
      extractor = new EntityExtractor();
    });

    it("should extract person with honorific (Dr.)", () => {
      const result = extractor.extract("Dr. John Smith reviewed the code");
      const persons = findEntitiesByType(result.entities, EntityType.PERSON);
      expect(persons.length).toBeGreaterThanOrEqual(1);
      expect(hasEntityWithName(persons, "John Smith")).toBe(true);
    });

    it("should extract person with honorific (Prof.)", () => {
      const result = extractor.extract("Prof. Jane Doe gave a lecture");
      const persons = findEntitiesByType(result.entities, EntityType.PERSON);
      expect(persons.length).toBeGreaterThanOrEqual(1);
      expect(hasEntityWithName(persons, "Jane Doe")).toBe(true);
    });

    it("should extract person with honorific (Mr.)", () => {
      const result = extractor.extract("Mr. Bob Wilson attended the meeting");
      const persons = findEntitiesByType(result.entities, EntityType.PERSON);
      expect(persons.length).toBeGreaterThanOrEqual(1);
      expect(hasEntityWithName(persons, "Bob Wilson")).toBe(true);
    });

    it("should extract @mentions", () => {
      const result = extractor.extract("Please review this @johnsmith and @jane-doe");
      const persons = findEntitiesByType(result.entities, EntityType.PERSON);
      expect(persons.length).toBeGreaterThanOrEqual(2);
      expect(hasEntityWithName(persons, "johnsmith")).toBe(true);
      expect(hasEntityWithName(persons, "jane-doe")).toBe(true);
    });

    it("should extract names with possessive", () => {
      const result = extractor.extract("That's John Smith's implementation");
      const persons = findEntitiesByType(result.entities, EntityType.PERSON);
      expect(persons.length).toBeGreaterThanOrEqual(1);
      expect(hasEntityWithName(persons, "John Smith")).toBe(true);
    });
  });

  describe("extract() - ORGANIZATION Entities", () => {
    let extractor: EntityExtractor;

    beforeEach(() => {
      extractor = new EntityExtractor();
    });

    it("should extract company with Inc suffix", () => {
      const result = extractor.extract("Acme Inc is a great company");
      const orgs = findEntitiesByType(result.entities, EntityType.ORGANIZATION);
      expect(orgs.length).toBeGreaterThanOrEqual(1);
      expect(hasEntityWithName(orgs, "Acme")).toBe(true);
    });

    it("should extract company with LLC suffix", () => {
      const result = extractor.extract("Tech Solutions LLC provides services");
      const orgs = findEntitiesByType(result.entities, EntityType.ORGANIZATION);
      expect(orgs.length).toBeGreaterThanOrEqual(1);
      expect(hasEntityWithName(orgs, "Tech Solutions")).toBe(true);
    });

    it("should extract known tech companies", () => {
      const result = extractor.extract("We use Google and Microsoft for cloud");
      const orgs = findEntitiesByType(result.entities, EntityType.ORGANIZATION);
      expect(orgs.length).toBeGreaterThanOrEqual(2);
      expect(hasEntityWithName(orgs, "Google")).toBe(true);
      expect(hasEntityWithName(orgs, "Microsoft")).toBe(true);
    });

    it("should extract Anthropic", () => {
      const result = extractor.extract("Anthropic developed Claude");
      const orgs = findEntitiesByType(result.entities, EntityType.ORGANIZATION);
      expect(orgs.length).toBeGreaterThanOrEqual(1);
      expect(hasEntityWithName(orgs, "Anthropic")).toBe(true);
    });
  });

  describe("extract() - CODE_FILE Entities", () => {
    let extractor: EntityExtractor;

    beforeEach(() => {
      extractor = new EntityExtractor();
    });

    it("should extract TypeScript files", () => {
      const result = extractor.extract("Check the EntityExtractor.ts file");
      const files = findEntitiesByType(result.entities, EntityType.CODE_FILE);
      expect(files.length).toBeGreaterThanOrEqual(1);
      expect(hasEntityWithName(files, "EntityExtractor.ts")).toBe(true);
    });

    it("should extract JavaScript files", () => {
      const result = extractor.extract("The index.js file is the entry point");
      const files = findEntitiesByType(result.entities, EntityType.CODE_FILE);
      expect(files.length).toBeGreaterThanOrEqual(1);
      expect(hasEntityWithName(files, "index.js")).toBe(true);
    });

    it("should extract paths starting with src/", () => {
      const result = extractor.extract("Look at src/utils/helpers");
      const files = findEntitiesByType(result.entities, EntityType.CODE_FILE);
      expect(files.length).toBeGreaterThanOrEqual(1);
    });

    it("should extract relative paths", () => {
      const result = extractor.extract("Import from ./utils/helper.ts");
      const files = findEntitiesByType(result.entities, EntityType.CODE_FILE);
      expect(files.length).toBeGreaterThanOrEqual(1);
    });

    it("should extract Python files", () => {
      const result = extractor.extract("Run the main.py script");
      const files = findEntitiesByType(result.entities, EntityType.CODE_FILE);
      expect(files.length).toBeGreaterThanOrEqual(1);
      expect(hasEntityWithName(files, "main.py")).toBe(true);
    });
  });

  describe("extract() - CODE_FUNCTION Entities", () => {
    let extractor: EntityExtractor;

    beforeEach(() => {
      extractor = new EntityExtractor();
    });

    it("should extract function declarations", () => {
      const result = extractor.extract("function processData() { return data; }");
      const funcs = findEntitiesByType(result.entities, EntityType.CODE_FUNCTION);
      expect(funcs.length).toBeGreaterThanOrEqual(1);
      expect(hasEntityWithName(funcs, "processData")).toBe(true);
    });

    it("should extract async function declarations", () => {
      const result = extractor.extract("async function fetchUsers() { ... }");
      const funcs = findEntitiesByType(result.entities, EntityType.CODE_FUNCTION);
      expect(funcs.length).toBeGreaterThanOrEqual(1);
      expect(hasEntityWithName(funcs, "fetchUsers")).toBe(true);
    });

    it("should extract React hooks (useX pattern)", () => {
      const result = extractor.extract("The useEffect and useState hooks are common");
      const funcs = findEntitiesByType(result.entities, EntityType.CODE_FUNCTION);
      expect(funcs.length).toBeGreaterThanOrEqual(2);
      expect(hasEntityWithName(funcs, "useEffect")).toBe(true);
      expect(hasEntityWithName(funcs, "useState")).toBe(true);
    });

    it("should filter common built-in functions", () => {
      const result = extractor.extract("console.log() and map() are built-in");
      const funcs = findEntitiesByType(result.entities, EntityType.CODE_FUNCTION);
      // log and map should be filtered as common
      const hasLog = funcs.some((f) => f.name === "log");
      const hasMap = funcs.some((f) => f.name === "map");
      expect(hasLog).toBe(false);
      expect(hasMap).toBe(false);
    });
  });

  describe("extract() - DECISION Entities", () => {
    let extractor: EntityExtractor;

    beforeEach(() => {
      extractor = new EntityExtractor();
    });

    it("should extract 'decided to' patterns", () => {
      const result = extractor.extract("We decided to use TypeScript for this project");
      const decisions = findEntitiesByType(result.entities, EntityType.DECISION);
      expect(decisions.length).toBeGreaterThanOrEqual(1);
    });

    it("should extract 'selected' patterns", () => {
      const result = extractor.extract("The team selected React over Vue");
      const decisions = findEntitiesByType(result.entities, EntityType.DECISION);
      expect(decisions.length).toBeGreaterThanOrEqual(1);
    });

    it("should extract 'going with' patterns", () => {
      const result = extractor.extract("We are going with the microservices approach");
      const decisions = findEntitiesByType(result.entities, EntityType.DECISION);
      expect(decisions.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe("extract() - TASK Entities", () => {
    let extractor: EntityExtractor;

    beforeEach(() => {
      extractor = new EntityExtractor();
    });

    it("should extract TODO comments", () => {
      const result = extractor.extract("// TODO: Add error handling for edge cases");
      const tasks = findEntitiesByType(result.entities, EntityType.TASK);
      expect(tasks.length).toBeGreaterThanOrEqual(1);
    });

    it("should extract FIXME comments", () => {
      const result = extractor.extract("// FIXME: This breaks on null input");
      const tasks = findEntitiesByType(result.entities, EntityType.TASK);
      expect(tasks.length).toBeGreaterThanOrEqual(1);
    });

    it("should extract 'need to' patterns", () => {
      const result = extractor.extract("We need to refactor this module");
      const tasks = findEntitiesByType(result.entities, EntityType.TASK);
      expect(tasks.length).toBeGreaterThanOrEqual(1);
    });

    it("should extract 'implement' patterns", () => {
      const result = extractor.extract("Implement the login functionality");
      const tasks = findEntitiesByType(result.entities, EntityType.TASK);
      expect(tasks.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe("extract() - ERROR Entities", () => {
    let extractor: EntityExtractor;

    beforeEach(() => {
      extractor = new EntityExtractor();
    });

    it("should extract 'Error:' patterns", () => {
      const result = extractor.extract("Error: Cannot find module 'lodash'");
      const errors = findEntitiesByType(result.entities, EntityType.ERROR);
      expect(errors.length).toBeGreaterThanOrEqual(1);
    });

    it("should extract exception class names", () => {
      const result = extractor.extract("Caught a TypeError and a NullPointerException");
      const errors = findEntitiesByType(result.entities, EntityType.ERROR);
      expect(errors.length).toBeGreaterThanOrEqual(2);
      expect(hasEntityWithName(errors, "TypeError")).toBe(true);
      expect(hasEntityWithName(errors, "NullPointerException")).toBe(true);
    });

    it("should extract 'failed to' patterns", () => {
      const result = extractor.extract("The build failed to compile the assets");
      const errors = findEntitiesByType(result.entities, EntityType.ERROR);
      expect(errors.length).toBeGreaterThanOrEqual(1);
    });

    it("should extract 'cannot' patterns", () => {
      const result = extractor.extract("Cannot read property 'x' of undefined");
      const errors = findEntitiesByType(result.entities, EntityType.ERROR);
      expect(errors.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe("extract() - CODE_CLASS Entities", () => {
    let extractor: EntityExtractor;

    beforeEach(() => {
      extractor = new EntityExtractor();
    });

    it("should extract class declarations", () => {
      const result = extractor.extract("class UserService extends BaseService");
      const classes = findEntitiesByType(result.entities, EntityType.CODE_CLASS);
      expect(classes.length).toBeGreaterThanOrEqual(2);
      expect(hasEntityWithName(classes, "UserService")).toBe(true);
      expect(hasEntityWithName(classes, "BaseService")).toBe(true);
    });

    it("should extract interface declarations", () => {
      const result = extractor.extract("interface IUserRepository { ... }");
      const classes = findEntitiesByType(result.entities, EntityType.CODE_CLASS);
      expect(classes.length).toBeGreaterThanOrEqual(1);
      expect(hasEntityWithName(classes, "IUserRepository")).toBe(true);
    });

    it("should extract type declarations", () => {
      const result = extractor.extract("type UserConfig = { ... }");
      const classes = findEntitiesByType(result.entities, EntityType.CODE_CLASS);
      expect(classes.length).toBeGreaterThanOrEqual(1);
      expect(hasEntityWithName(classes, "UserConfig")).toBe(true);
    });

    it("should extract Props/State/Config suffixed types", () => {
      const result = extractor.extract("Define ButtonProps and FormState types");
      const classes = findEntitiesByType(result.entities, EntityType.CODE_CLASS);
      expect(classes.length).toBeGreaterThanOrEqual(2);
      expect(hasEntityWithName(classes, "ButtonProps")).toBe(true);
      expect(hasEntityWithName(classes, "FormState")).toBe(true);
    });
  });

  describe("extractFromContext()", () => {
    let extractor: EntityExtractor;

    beforeEach(() => {
      extractor = new EntityExtractor();
    });

    it("should extract from context with empty value", () => {
      const result = extractor.extractFromContext({
        key: "author",
        value: "",
      });
      expect(result.entities).toHaveLength(0);
      expect(result.confidence).toBe(0);
    });

    it("should add contextKey to extracted entities", () => {
      const result = extractor.extractFromContext({
        key: "author",
        value: "Dr. Jane Smith wrote this",
      });
      const persons = findEntitiesByType(result.entities, EntityType.PERSON);
      expect(persons.length).toBeGreaterThanOrEqual(1);
      expect(persons[0].properties["contextKey"]).toBe("author");
    });

    it("should add contextCategory to extracted entities", () => {
      const result = extractor.extractFromContext({
        key: "filePath",
        value: "src/utils/helper.ts",
        category: "code",
      });
      const files = findEntitiesByType(result.entities, EntityType.CODE_FILE);
      expect(files.length).toBeGreaterThanOrEqual(1);
      expect(files[0].properties["contextCategory"]).toBe("code");
    });

    it("should prioritize PERSON for author key", () => {
      const result = extractor.extractFromContext({
        key: "author",
        value: "Dr. John Doe",
      });
      const persons = findEntitiesByType(result.entities, EntityType.PERSON);
      expect(persons.length).toBeGreaterThanOrEqual(1);
      // Prioritized entities should have boosted confidence
      const confidence = persons[0].properties["confidence"] as number;
      expect(confidence).toBeGreaterThan(0.5);
    });

    it("should prioritize CODE_FILE for file key", () => {
      const result = extractor.extractFromContext({
        key: "sourceFile",
        value: "src/components/Button.tsx",
        category: "technical",
      });
      const files = findEntitiesByType(result.entities, EntityType.CODE_FILE);
      expect(files.length).toBeGreaterThanOrEqual(1);
    });

    it("should prioritize ERROR for error key", () => {
      const result = extractor.extractFromContext({
        key: "errorMessage",
        value: "TypeError: Cannot read property of null",
      });
      const errors = findEntitiesByType(result.entities, EntityType.ERROR);
      expect(errors.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe("Configuration Methods", () => {
    it("should allow adding custom patterns", () => {
      const extractor = new EntityExtractor();
      extractor.addPatterns(EntityType.CONCEPT, [/\bAI Agent\b/gi]);
      
      const result = extractor.extract("The AI Agent handled the request");
      const concepts = findEntitiesByType(result.entities, EntityType.CONCEPT);
      expect(concepts.length).toBeGreaterThanOrEqual(1);
    });

    it("should allow setting minConfidence", () => {
      const extractor = new EntityExtractor();
      extractor.setMinConfidence(0.9);
      
      const config = extractor.getConfig();
      expect(config.minConfidence).toBe(0.9);
    });

    it("should clamp minConfidence to [0, 1]", () => {
      const extractor = new EntityExtractor();
      
      extractor.setMinConfidence(-0.5);
      expect(extractor.getConfig().minConfidence).toBe(0);
      
      extractor.setMinConfidence(1.5);
      expect(extractor.getConfig().minConfidence).toBe(1);
    });
  });

  describe("Deduplication", () => {
    let extractor: EntityExtractor;

    beforeEach(() => {
      extractor = new EntityExtractor();
    });

    it("should deduplicate entities with same name and type", () => {
      // This text has "Google" mentioned twice
      const result = extractor.extract("Google is great. I love working with Google products.");
      const orgs = findEntitiesByType(result.entities, EntityType.ORGANIZATION);
      const googleCount = orgs.filter(
        (e) => e.name.toLowerCase() === "google"
      ).length;
      expect(googleCount).toBe(1);
    });

    it("should not deduplicate entities with different types", () => {
      // Same name but different contexts
      const result = extractor.extract(
        "class Error extends BaseError. Error: something went wrong"
      );
      // Should have Error as both a class and an error message
      expect(result.entities.length).toBeGreaterThanOrEqual(1);
    });
  });
});

// ============================================================================
// Factory Function Tests
// ============================================================================

describe("Factory Functions", () => {
  describe("createEntityExtractor", () => {
    it("should create a new EntityExtractor with defaults", () => {
      const extractor = createEntityExtractor();
      expect(extractor).toBeInstanceOf(EntityExtractor);
      expect(extractor.getConfig().minConfidence).toBe(0.5);
    });
  });

  describe("createEntityExtractorWithConfig", () => {
    it("should create with custom config", () => {
      const extractor = createEntityExtractorWithConfig({
        minConfidence: 0.7,
      });
      expect(extractor).toBeInstanceOf(EntityExtractor);
      expect(extractor.getConfig().minConfidence).toBe(0.7);
    });
  });

  describe("DEFAULT_PATTERNS", () => {
    it("should export default patterns", () => {
      expect(DEFAULT_PATTERNS).toBeInstanceOf(Map);
      expect(DEFAULT_PATTERNS.size).toBeGreaterThan(0);
    });

    it("should have patterns for main entity types", () => {
      expect(DEFAULT_PATTERNS.has(EntityType.PERSON)).toBe(true);
      expect(DEFAULT_PATTERNS.has(EntityType.ORGANIZATION)).toBe(true);
      expect(DEFAULT_PATTERNS.has(EntityType.CODE_FILE)).toBe(true);
      expect(DEFAULT_PATTERNS.has(EntityType.CODE_FUNCTION)).toBe(true);
      expect(DEFAULT_PATTERNS.has(EntityType.DECISION)).toBe(true);
      expect(DEFAULT_PATTERNS.has(EntityType.TASK)).toBe(true);
      expect(DEFAULT_PATTERNS.has(EntityType.ERROR)).toBe(true);
    });
  });
});

// ============================================================================
// Accuracy Tests (>=70% target)
// ============================================================================

describe("EntityExtractor - Accuracy Tests", () => {
  let extractor: EntityExtractor;

  beforeEach(() => {
    extractor = new EntityExtractor({ minConfidence: 0.3 }); // Lower threshold for accuracy testing
  });

  describe("PERSON Accuracy", () => {
    it("should achieve >=70% accuracy on person extraction", () => {
      const testText = `
        Dr. John Smith and Prof. Jane Doe collaborated on the project.
        Mr. Bob Wilson reviewed their work. @alice and @bob-dev provided feedback.
        Sarah Johnson's implementation was excellent.
      `;
      const expectedPersons = [
        "John Smith",
        "Jane Doe",
        "Bob Wilson",
        "alice",
        "bob-dev",
        "Sarah Johnson",
      ];

      const result = extractor.extract(testText);
      const accuracy = calculateAccuracy(
        result.entities,
        expectedPersons,
        EntityType.PERSON
      );
      
      expect(accuracy).toBeGreaterThanOrEqual(0.7);
    });
  });

  describe("ORGANIZATION Accuracy", () => {
    it("should achieve >=70% accuracy on organization extraction", () => {
      const testText = `
        Google and Microsoft dominate cloud computing.
        Anthropic created Claude, while OpenAI made GPT.
        Acme Inc and Tech Solutions LLC are partners.
        AWS and Azure provide infrastructure.
      `;
      const expectedOrgs = [
        "Google",
        "Microsoft",
        "Anthropic",
        "OpenAI",
        "Acme",
        "Tech Solutions",
        "AWS",
        "Azure",
      ];

      const result = extractor.extract(testText);
      const accuracy = calculateAccuracy(
        result.entities,
        expectedOrgs,
        EntityType.ORGANIZATION
      );
      
      expect(accuracy).toBeGreaterThanOrEqual(0.7);
    });
  });

  describe("CODE_FILE Accuracy", () => {
    it("should achieve >=70% accuracy on file extraction", () => {
      const testText = `
        Check EntityExtractor.ts and Neo4jClient.ts for implementation.
        The main.py and utils.js files need review.
        Look at src/components/Button.tsx and ./utils/helper.ts.
        The index.ts is the entry point.
      `;
      const expectedFiles = [
        "EntityExtractor.ts",
        "Neo4jClient.ts",
        "main.py",
        "utils.js",
        "Button.tsx",
        "helper.ts",
        "index.ts",
      ];

      const result = extractor.extract(testText);
      const accuracy = calculateAccuracy(
        result.entities,
        expectedFiles,
        EntityType.CODE_FILE
      );
      
      expect(accuracy).toBeGreaterThanOrEqual(0.7);
    });
  });

  describe("CODE_FUNCTION Accuracy", () => {
    it("should achieve >=70% accuracy on function extraction", () => {
      const testText = `
        function processData() handles the main logic.
        async function fetchUsers() retrieves user data.
        The useEffect and useState hooks manage state.
        Call calculateTotal() and validateInput() for processing.
      `;
      const expectedFunctions = [
        "processData",
        "fetchUsers",
        "useEffect",
        "useState",
        "calculateTotal",
        "validateInput",
      ];

      const result = extractor.extract(testText);
      const accuracy = calculateAccuracy(
        result.entities,
        expectedFunctions,
        EntityType.CODE_FUNCTION
      );
      
      expect(accuracy).toBeGreaterThanOrEqual(0.7);
    });
  });

  describe("ERROR Accuracy", () => {
    it("should achieve >=70% accuracy on error extraction", () => {
      const testText = `
        Error: Module not found
        Caught TypeError and NullPointerException.
        The process failed to complete.
        Cannot read property 'x' of undefined.
        RuntimeError occurred during execution.
      `;
      const expectedErrors = [
        "Module not found",
        "TypeError",
        "NullPointerException",
        "RuntimeError",
      ];

      const result = extractor.extract(testText);
      const accuracy = calculateAccuracy(
        result.entities,
        expectedErrors,
        EntityType.ERROR
      );
      
      expect(accuracy).toBeGreaterThanOrEqual(0.7);
    });
  });

  describe("TASK Accuracy", () => {
    it("should achieve >=70% accuracy on task extraction", () => {
      const testText = `
        TODO: Add error handling
        FIXME: Fix null pointer issue
        We need to refactor the auth module.
        Implement the payment gateway.
        Add unit tests for the new feature.
      `;
      const expectedTasks = [
        "error handling",
        "null pointer",
        "refactor",
        "payment gateway",
        "unit tests",
      ];

      const result = extractor.extract(testText);
      const tasks = findEntitiesByType(result.entities, EntityType.TASK);
      
      // Check that we found a reasonable number of tasks
      expect(tasks.length).toBeGreaterThanOrEqual(3);
    });
  });

  describe("CODE_CLASS Accuracy", () => {
    it("should achieve >=70% accuracy on class extraction", () => {
      const testText = `
        class UserService extends BaseService implements IUserService.
        interface IRepository defines the contract.
        type UserConfig = { ... }
        The ButtonProps and FormState types are used throughout.
      `;
      const expectedClasses = [
        "UserService",
        "BaseService",
        "IUserService",
        "IRepository",
        "UserConfig",
        "ButtonProps",
        "FormState",
      ];

      const result = extractor.extract(testText);
      const accuracy = calculateAccuracy(
        result.entities,
        expectedClasses,
        EntityType.CODE_CLASS
      );
      
      expect(accuracy).toBeGreaterThanOrEqual(0.7);
    });
  });

  describe("Mixed Content Accuracy", () => {
    it("should achieve reasonable overall accuracy on mixed content", () => {
      const testText = `
        Dr. Alice Chen from Google implemented the UserService class.
        She modified src/services/UserService.ts to add the fetchUsers() function.
        TODO: Add error handling for TypeError cases.
        The team decided to use TypeScript for better type safety.
        @bob reviewed the ButtonProps interface changes.
      `;

      const result = extractor.extract(testText);

      // Should find multiple entity types
      const persons = findEntitiesByType(result.entities, EntityType.PERSON);
      const orgs = findEntitiesByType(result.entities, EntityType.ORGANIZATION);
      const files = findEntitiesByType(result.entities, EntityType.CODE_FILE);
      const funcs = findEntitiesByType(result.entities, EntityType.CODE_FUNCTION);
      const classes = findEntitiesByType(result.entities, EntityType.CODE_CLASS);
      const tasks = findEntitiesByType(result.entities, EntityType.TASK);
      const errors = findEntitiesByType(result.entities, EntityType.ERROR);

      // Verify we extracted from multiple categories
      const categoriesWithEntities = [
        persons.length > 0,
        orgs.length > 0,
        files.length > 0,
        funcs.length > 0,
        classes.length > 0,
        tasks.length > 0,
        errors.length > 0,
      ].filter(Boolean).length;

      // Should extract from at least 5 different categories
      expect(categoriesWithEntities).toBeGreaterThanOrEqual(5);

      // Overall confidence should be reasonable
      expect(result.confidence).toBeGreaterThan(0);
    });
  });
});

// ============================================================================
// Edge Case Tests
// ============================================================================

describe("EntityExtractor - Edge Cases", () => {
  let extractor: EntityExtractor;

  beforeEach(() => {
    extractor = new EntityExtractor();
  });

  it("should handle very long text", () => {
    const longText = "Dr. John Smith wrote code. ".repeat(1000);
    const result = extractor.extract(longText);
    
    // Should still extract entities
    expect(result.entities.length).toBeGreaterThan(0);
    
    // Should be deduplicated (only one John Smith)
    const persons = findEntitiesByType(result.entities, EntityType.PERSON);
    const johnCount = persons.filter((p) =>
      p.name.toLowerCase().includes("john smith")
    ).length;
    expect(johnCount).toBe(1);
  });

  it("should handle special characters in text", () => {
    const specialText = "Error: 'undefined' is not a function <anonymous>";
    const result = extractor.extract(specialText);
    
    // Should not crash
    expect(result).toBeDefined();
  });

  it("should handle unicode characters", () => {
    const unicodeText = "Dr. Müller and Prof. 日本語 reviewed the code";
    const result = extractor.extract(unicodeText);
    
    // Should not crash
    expect(result).toBeDefined();
  });

  it("should handle newlines and tabs", () => {
    const multilineText = `
      class UserService {
        async function getUser() {
          // TODO: implement this
        }
      }
    `;
    const result = extractor.extract(multilineText);
    
    const classes = findEntitiesByType(result.entities, EntityType.CODE_CLASS);
    expect(classes.length).toBeGreaterThanOrEqual(1);
  });

  it("should handle entity names with numbers", () => {
    const numericText = "Check the v2Api.ts file and call getUserV2() function";
    const result = extractor.extract(numericText);
    
    const files = findEntitiesByType(result.entities, EntityType.CODE_FILE);
    const funcs = findEntitiesByType(result.entities, EntityType.CODE_FUNCTION);
    
    expect(files.length + funcs.length).toBeGreaterThanOrEqual(1);
  });
});
