# Agent Guidelines for pr_review

This document provides essential information for AI coding agents working in this repository.

## Project Overview

This is a TypeScript/Node.js project using modern tooling and best practices.

## Build, Lint, and Test Commands

### Building
```bash
npm run build          # Build the project
npm run build:watch    # Build in watch mode
npm run dev            # Run in development mode
```

### Linting and Formatting
```bash
npm run lint           # Run Biome linter
npm run lint:fix       # Run Biome linter with auto-fix
npm run format         # Format code with Biome
npm run format:check   # Check formatting without modifying files
```

### Testing
```bash
npm test               # Run all tests
npm run test:watch     # Run tests in watch mode
npm run test:coverage  # Run tests with coverage report
npm run test:ui        # Run tests with Vitest UI

# Running a single test file
npm test path/to/test-file.test.ts

# Running a single test by name pattern
npm test -- -t "test name pattern"

# Running tests for a specific file pattern
npm test -- path/to/**/*.test.ts
```

## Code Style Guidelines

### Imports

1. **Import Order**: Group imports in the following order with blank lines between groups:
   - External dependencies (node_modules)
   - Internal absolute imports (using path aliases like `@/`)
   - Relative imports from parent directories (`../`)
   - Relative imports from current directory (`./`)
   - Type-only imports at the end of each group

2. **Import Style**:
   ```typescript
   // Prefer named imports
   import { something } from 'package';
   
   // Use type-only imports for types
   import type { SomeType } from './types';
   
   // Avoid wildcard imports except for specific cases
   import * as fs from 'node:fs'; // OK for Node.js built-ins
   ```

3. **Path Aliases**: Use configured path aliases (e.g., `@/`) for cleaner imports when available.

### Formatting

- **Indentation**: 2 spaces (no tabs)
- **Line Length**: 100 characters max (enforced by Biome)
- **Semicolons**: Required at the end of statements
- **Quotes**: Single quotes for strings, double quotes in JSX/TSX
- **Trailing Commas**: Always include in multi-line structures
- **Arrow Functions**: Use implicit returns for single expressions

### TypeScript Best Practices

1. **Type Annotations**:
   - Always annotate function parameters and return types
   - Avoid using `any`; use `unknown` when type is truly unknown
   - Prefer interfaces for object shapes, types for unions/intersections
   - Use `readonly` for immutable properties
   
   ```typescript
   // Good
   function processData(data: UserData): ProcessedResult {
     // implementation
   }
   
   // Avoid
   function processData(data) {
     // implementation
   }
   ```

2. **Type Inference**: Let TypeScript infer types for simple variable assignments:
   ```typescript
   const count = 5; // Good - type inferred as number
   const count: number = 5; // Redundant
   ```

3. **Null Safety**:
   - Enable `strictNullChecks` in tsconfig.json
   - Use optional chaining (`?.`) and nullish coalescing (`??`)
   - Explicitly handle null/undefined cases

### Naming Conventions

- **Variables/Functions**: `camelCase`
- **Classes/Interfaces/Types**: `PascalCase`
- **Constants**: `UPPER_SNAKE_CASE` for true constants, `camelCase` for const variables
- **Private Fields**: Prefix with underscore `_privateField` or use `#privateField`
- **File Names**: 
  - Use `kebab-case.ts` for utility files
  - Use `PascalCase.ts` for class/component files
  - Use `*.test.ts` for test files
  - Use `*.spec.ts` for specification files

### Error Handling

1. **Use Custom Error Classes**:
   ```typescript
   class ValidationError extends Error {
     constructor(message: string) {
       super(message);
       this.name = 'ValidationError';
     }
   }
   ```

2. **Always Handle Errors**:
   - Use try/catch for async operations
   - Provide meaningful error messages
   - Log errors appropriately
   - Don't swallow errors silently

3. **Prefer Result Types** for expected failures:
   ```typescript
   type Result<T, E = Error> = { ok: true; value: T } | { ok: false; error: E };
   ```

### Async/Await

- Prefer `async/await` over raw promises
- Always handle rejected promises
- Use `Promise.all()` for parallel operations
- Avoid `async` without `await` in the function body

### Comments and Documentation

- Use JSDoc comments for public APIs:
  ```typescript
  /**
   * Processes user data and returns the result.
   * @param data - The user data to process
   * @returns The processed result
   * @throws {ValidationError} If data is invalid
   */
  ```
- Write self-documenting code; minimize inline comments
- Use inline comments only to explain "why", not "what"
- Keep comments up-to-date with code changes

### Testing Guidelines

- **Test File Location**: Place tests adjacent to source files or in `__tests__` directory
- **Test Naming**: Use descriptive test names with `describe` and `it/test` blocks
- **AAA Pattern**: Arrange, Act, Assert structure
- **Mocking**: Use Vitest's built-in mocking utilities
- **Coverage**: Aim for 80%+ coverage for critical paths

```typescript
import { describe, it, expect, vi } from 'vitest';

describe('functionName', () => {
  it('should handle valid input correctly', () => {
    // Arrange
    const input = { /* test data */ };
    
    // Act
    const result = functionName(input);
    
    // Assert
    expect(result).toBe(expected);
  });
});
```

## General Guidelines for Agents

1. **Before Making Changes**:
   - Read existing code to understand patterns and conventions
   - Check for similar implementations in the codebase
   - Run tests to ensure current state is working

2. **When Adding Features**:
   - Follow existing architectural patterns
   - Add tests for new functionality
   - Update documentation if needed
   - Run linter and fix any issues

3. **When Fixing Bugs**:
   - Write a failing test that reproduces the bug
   - Fix the bug
   - Verify the test passes
   - Check for similar issues elsewhere

4. **Before Committing**:
   - Run `npm run lint:fix` to auto-fix linting issues
   - Run `npm test` to ensure all tests pass
   - Run `npm run format` to format code
   - Review changes for unintended modifications

5. **Performance Considerations**:
   - Avoid synchronous operations in async contexts
   - Use streaming for large data processing
   - Consider memory usage for large datasets
   - Profile before optimizing

---

*This document should be updated as the project evolves and new conventions are established.*
