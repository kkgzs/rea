import * as t from "@babel/types";

import {
  readExactJavaScriptLiteral,
  semanticLiteralProperty,
  semanticStaticPropertyKey,
  unwrapJavaScriptExpression,
} from "./javascriptAstValues.js";
import {
  resolveSemanticBindingState,
  type JavaScriptSemanticAnalysisState,
} from "./javascriptSemanticState.js";

interface GeneratorPrefixFacts {
  readonly before: WeakMap<t.Node, number>;
  readonly yielded: readonly t.YieldExpression[];
  readonly firstPatternWait: WeakMap<t.ArrayPattern, number | null>;
}
const prefixes = new WeakMap<t.Node, GeneratorPrefixFacts>();

/** Index only straight-line owned yields; uncertain branches do not prove a resume phase. */
const generatorPrefixes = (
  body: t.Node,
  ordered: (node: t.Node) => readonly t.Node[],
  maySuspend: (node: t.Node) => boolean,
): GeneratorPrefixFacts => {
  const cached = prefixes.get(body);
  if (cached !== undefined) return cached;
  const before = new WeakMap<t.Node, number>();
  const yielded: t.YieldExpression[] = [];
  let completed = 0;
  const pending: { node: t.Node; exit?: true }[] = [{ node: body }];
  while (pending.length > 0) {
    const entry = pending.pop();
    if (entry === undefined) continue;
    const node = unwrapJavaScriptExpression(entry.node).node;
    if (entry.exit === true) {
      if (t.isYieldExpression(node)) {
        if (node.delegate) completed = -1;
        else if (completed >= 0) {
          yielded.push(node);
          completed += 1;
        }
      }
      continue;
    }
    before.set(node, completed);
    if (t.isFunction(node)) continue;
    if (
      (t.isIfStatement(node) ||
        t.isConditionalExpression(node) ||
        t.isLogicalExpression(node) ||
        t.isLoop(node) ||
        t.isSwitchStatement(node) ||
        t.isTryStatement(node)) &&
      maySuspend(node)
    )
      completed = -1;
    if (t.isYieldExpression(node)) pending.push({ node, exit: true });
    const children = ordered(node);
    for (const child of children.toReversed()) pending.push({ node: child });
  }
  const facts = {
    before,
    yielded,
    firstPatternWait: new WeakMap<t.ArrayPattern, number | null>(),
  };
  prefixes.set(body, facts);
  return facts;
};

type PatternValue = { readonly known: boolean; readonly node?: t.Node };

const undefinedPatternValue = (
  value: PatternValue,
  state: JavaScriptSemanticAnalysisState,
): boolean => {
  const argument =
    value.node === undefined
      ? undefined
      : unwrapJavaScriptExpression(value.node).node;
  return (
    value.known &&
    (argument === undefined ||
      (t.isIdentifier(argument, { name: "undefined" }) &&
        resolveSemanticBindingState(state, argument, "undefined") ===
          undefined) ||
      (t.isUnaryExpression(argument, { operator: "void" }) &&
        readExactJavaScriptLiteral(argument.argument).found))
  );
};

/** Only an explicit literal data value proves default selection; inherited keys stay unknown. */
const patternPropertyValue = (
  value: PatternValue,
  key: string | number,
): PatternValue => {
  if (!value.known || value.node === undefined) return { known: false };
  const node = unwrapJavaScriptExpression(value.node).node;
  const selected = semanticLiteralProperty(node, key);
  if (selected !== undefined) return { known: true, node: selected };
  return { known: false };
};

/** Work completed inside a consumed slot precedes the next generator resume. */
const patternCompletedSuspension = (
  pattern: t.Node,
  value: PatternValue,
  state: JavaScriptSemanticAnalysisState,
  suspended: (node: t.Node) => boolean,
  depth = 0,
  target?: t.Node,
  targetPath?: ReadonlySet<t.Node>,
): boolean => {
  if (depth >= 128 || pattern === target) return false;
  if (t.isAssignmentPattern(pattern)) {
    const selectsDefault = undefinedPatternValue(value, state);
    return (
      (selectsDefault && suspended(pattern.right)) ||
      patternCompletedSuspension(
        pattern.left,
        selectsDefault ? { known: true, node: pattern.right } : value,
        state,
        suspended,
        depth + 1,
        target,
        targetPath,
      )
    );
  }
  if (t.isObjectPattern(pattern))
    for (const property of pattern.properties) {
      if (t.isRestElement(property)) continue;
      if (property.computed && suspended(property.key)) return true;
      const key = semanticStaticPropertyKey(property.key, property.computed);
      if (
        patternCompletedSuspension(
          property.value,
          key === null ? { known: false } : patternPropertyValue(value, key),
          state,
          suspended,
          depth + 1,
          target,
          targetPath,
        )
      )
        return true;
      if (targetPath?.has(property)) return false;
    }
  if (t.isArrayPattern(pattern))
    for (const [index, element] of pattern.elements.entries()) {
      if (element === null || t.isRestElement(element)) continue;
      if (
        patternCompletedSuspension(
          element,
          patternPropertyValue(value, index),
          state,
          suspended,
          depth + 1,
          target,
          targetPath,
        )
      )
        return true;
      if (targetPath?.has(element)) return false;
    }
  return false;
};

/** Selected defaults and keys before a particular destructuring write share slot semantics. */
export const semanticPatternSuspendsBeforeTarget = (
  pattern: t.Node,
  value: t.Node,
  target: t.Node,
  state: JavaScriptSemanticAnalysisState,
  completedSuspension: (node: t.Node) => boolean,
): boolean => {
  const path = new Set<t.Node>();
  let current: t.Node | undefined = target;
  while (current !== undefined) {
    path.add(current);
    if (current === pattern)
      return patternCompletedSuspension(
        pattern,
        { known: true, node: value },
        state,
        completedSuspension,
        0,
        target,
        path,
      );
    current = state.parentsByNode.get(current);
  }
  return false;
};

/** Only completed work in an earlier consumed slot can delay the next iterator step. */
export const semanticPatternSuspendsBeforeGeneratorRead = ({
  read,
  body,
  pattern,
  state,
  ordered,
  maySuspend,
  completedSuspension,
}: {
  readonly read: t.Node;
  readonly body: t.Node;
  readonly pattern: t.ArrayPattern;
  readonly state: JavaScriptSemanticAnalysisState;
  readonly ordered: (node: t.Node) => readonly t.Node[];
  readonly maySuspend: (node: t.Node) => boolean;
  readonly completedSuspension: (node: t.Node) => boolean;
}): boolean => {
  const facts = generatorPrefixes(body, ordered, maySuspend);
  const count = facts.before.get(unwrapJavaScriptExpression(read).node);
  if (count === undefined || count < 0) return false;
  const cached = facts.firstPatternWait.get(pattern);
  if (cached !== undefined) return cached !== null && cached < count;
  for (let index = 0; index < pattern.elements.length; index += 1) {
    const element = pattern.elements[index];
    if (t.isRestElement(element)) break;
    if (element == null) continue;
    const yielded = facts.yielded[index];
    if (yielded === undefined) break;
    if (
      patternCompletedSuspension(
        element,
        {
          known: true,
          ...(yielded.argument == null ? {} : { node: yielded.argument }),
        },
        state,
        completedSuspension,
      )
    ) {
      facts.firstPatternWait.set(pattern, index);
      return index < count;
    }
  }
  facts.firstPatternWait.set(pattern, null);
  return false;
};
