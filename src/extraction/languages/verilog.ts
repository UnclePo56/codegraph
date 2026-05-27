import type { Node as SyntaxNode } from 'web-tree-sitter';
import type { Node } from '../../types';
import { getNodeText } from '../tree-sitter-helpers';
import type { ExtractorContext, LanguageExtractor } from '../tree-sitter-types';

const IDENTIFIER_TYPES = new Set([
  'simple_identifier',
  'escaped_identifier',
]);

function cleanIdentifier(text: string): string {
  return text.replace(/^\\/, '').trim();
}

function firstIdentifier(node: SyntaxNode | null): SyntaxNode | null {
  if (!node) return null;
  if (IDENTIFIER_TYPES.has(node.type)) return node;

  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);
    const found = firstIdentifier(child);
    if (found) return found;
  }

  return null;
}

function trailingIdentifier(node: SyntaxNode): SyntaxNode | null {
  for (let i = node.namedChildCount - 1; i >= 0; i--) {
    const child = node.namedChild(i);
    const found = firstIdentifier(child);
    if (found) return found;
  }

  return null;
}

function firstDescendantOfType(node: SyntaxNode, types: ReadonlySet<string>): SyntaxNode | null {
  if (types.has(node.type)) return node;

  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);
    if (!child) continue;
    const found = firstDescendantOfType(child, types);
    if (found) return found;
  }

  return null;
}

function descendantsOfType(node: SyntaxNode, types: ReadonlySet<string>, out: SyntaxNode[] = []): SyntaxNode[] {
  if (types.has(node.type)) {
    out.push(node);
  }

  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);
    if (child) descendantsOfType(child, types, out);
  }

  return out;
}

type PreprocessorFrame = {
  parentActive: boolean;
  branchTaken: boolean;
  currentActive: boolean;
};

const PREPROCESSOR_DIRECTIVE_RE = /^\s*`(ifdef|ifndef|elsif|else|endif|define|undef)\b\s*([A-Za-z_][A-Za-z0-9_$]*)?/;
const DEFINE_ENV_KEYS = ['CODEGRAPH_VERILOG_DEFINES', 'CODEGRAPH_HDL_DEFINES'];
const activeLineCache = new Map<string, boolean[]>();

function configuredDefines(): Set<string> {
  const defines = new Set<string>();
  for (const key of DEFINE_ENV_KEYS) {
    const raw = process.env[key];
    if (!raw) continue;
    for (const token of raw.split(/[,\s;]+/)) {
      const name = token.trim().replace(/=.*/, '');
      if (name) defines.add(name);
    }
  }
  return defines;
}

function activeLineMap(source: string): boolean[] {
  const envKey = DEFINE_ENV_KEYS.map((key) => `${key}=${process.env[key] ?? ''}`).join('|');
  const cacheKey = `${envKey}\0${source}`;
  const cached = activeLineCache.get(cacheKey);
  if (cached) return cached;

  const defines = configuredDefines();
  const frames: PreprocessorFrame[] = [];
  const lines = source.split(/\r?\n/);
  const active = new Array<boolean>(lines.length).fill(true);
  const stackActive = () => frames.every((frame) => frame.currentActive);

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
    const line = lines[lineIndex] ?? '';
    const match = line.match(PREPROCESSOR_DIRECTIVE_RE);
    if (!match) {
      active[lineIndex] = stackActive();
      continue;
    }

    const directive = match[1];
    const name = match[2];
    active[lineIndex] = false;

    if (directive === 'ifdef' || directive === 'ifndef') {
      const parentActive = stackActive();
      const defined = name ? defines.has(name) : false;
      const branchMatches = directive === 'ifdef' ? defined : !defined;
      frames.push({
        parentActive,
        branchTaken: branchMatches,
        currentActive: parentActive && branchMatches,
      });
    } else if (directive === 'elsif') {
      const frame = frames[frames.length - 1];
      if (!frame) continue;
      const branchMatches = Boolean(name && defines.has(name));
      const currentActive = frame.parentActive && !frame.branchTaken && branchMatches;
      frame.currentActive = currentActive;
      frame.branchTaken = frame.branchTaken || branchMatches;
    } else if (directive === 'else') {
      const frame = frames[frames.length - 1];
      if (!frame) continue;
      const currentActive = frame.parentActive && !frame.branchTaken;
      frame.currentActive = currentActive;
      frame.branchTaken = true;
    } else if (directive === 'endif') {
      frames.pop();
    } else if (directive === 'define') {
      if (stackActive() && name) defines.add(name);
    } else if (directive === 'undef') {
      if (stackActive() && name) defines.delete(name);
    }
  }

  activeLineCache.set(cacheKey, active);
  return active;
}

export function preprocessVerilogSource(source: string): string {
  const active = activeLineMap(source);
  return source
    .split(/\r?\n/)
    .map((line, lineIndex) => active[lineIndex] === false ? '' : line)
    .join('\n');
}

function isActiveNode(node: SyntaxNode, ctx: ExtractorContext): boolean {
  return activeLineMap(ctx.source)[node.startPosition.row] !== false;
}

function isPreprocessorDirective(node: SyntaxNode, ctx: ExtractorContext): boolean {
  return PREPROCESSOR_DIRECTIVE_RE.test(getNodeText(node, ctx.source));
}

function activeDescendantsOfType(
  node: SyntaxNode,
  types: ReadonlySet<string>,
  ctx: ExtractorContext,
  out: SyntaxNode[] = []
): SyntaxNode[] {
  if (!isActiveNode(node, ctx)) return out;
  if (types.has(node.type)) {
    out.push(node);
  }

  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);
    if (child) activeDescendantsOfType(child, types, ctx, out);
  }

  return out;
}

function namedChildOfType(node: SyntaxNode, types: ReadonlySet<string>): SyntaxNode | null {
  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);
    if (child && types.has(child.type)) return child;
  }
  return null;
}

const DECL_NAME_TYPES: Record<string, string[]> = {
  module_declaration: ['module_header', 'module_ansi_header', 'module_nonansi_header'],
  interface_declaration: ['interface_ansi_header', 'interface_nonansi_header'],
  package_declaration: ['package_identifier'],
  program_declaration: ['program_ansi_header', 'program_nonansi_header', 'program_identifier'],
  checker_declaration: ['checker_identifier'],
  covergroup_declaration: ['covergroup_identifier'],
  class_declaration: ['class_identifier'],
  interface_class_declaration: ['class_identifier'],
  function_declaration: ['function_identifier'],
  function_body_declaration: ['function_identifier'],
  function_prototype: ['function_identifier'],
  task_declaration: ['task_identifier'],
  task_body_declaration: ['task_identifier'],
  task_prototype: ['task_identifier'],
  property_declaration: ['property_identifier'],
};

function resolveVerilogName(node: SyntaxNode, source: string): string | undefined {
  if (node.type === 'class_constructor_declaration' || node.type === 'class_constructor_prototype') {
    return 'new';
  }

  const preferredTypes = new Set(DECL_NAME_TYPES[node.type] ?? []);
  const preferredNode = preferredTypes.size > 0
    ? firstDescendantOfType(node, preferredTypes)
    : null;
  const idNode = firstIdentifier(preferredNode ?? node);
  return idNode ? cleanIdentifier(getNodeText(idNode, source)) : undefined;
}

function compactSignature(node: SyntaxNode, source: string): string | undefined {
  const text = getNodeText(node, source).replace(/\s+/g, ' ').trim();
  if (!text) return undefined;
  const semi = text.indexOf(';');
  const head = semi >= 0 ? text.slice(0, semi + 1) : text;
  return head.length > 160 ? `${head.slice(0, 157)}...` : head;
}

function createScopedNode(
  ctx: ExtractorContext,
  kind: 'module' | 'namespace' | 'class' | 'interface',
  node: SyntaxNode,
  name: string,
  extra?: { signature?: string }
): boolean {
  const created = ctx.createNode(kind, name, node, extra);
  if (!created) return true;

  ctx.pushScope(created.id);
  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);
    if (child) ctx.visitNode(child);
  }
  ctx.popScope();
  return true;
}

function currentParentKind(ctx: ExtractorContext): string | undefined {
  const parentId = ctx.nodeStack[ctx.nodeStack.length - 1];
  return ctx.nodes.find((node) => node.id === parentId)?.kind;
}

function currentQualifiedName(ctx: ExtractorContext, name: string): string {
  const parts = ctx.nodeStack
    .map((nodeId) => ctx.nodes.find((node) => node.id === nodeId))
    .filter((node) => node && node.kind !== 'file')
    .map((node) => node!.name);
  parts.push(name);
  return parts.join('::');
}

function hasScopedNode(
  ctx: ExtractorContext,
  kinds: ReadonlySet<string>,
  name: string
): boolean {
  const qualifiedName = currentQualifiedName(ctx, name);
  return ctx.nodes.some((node) => (
    kinds.has(node.kind) &&
    node.qualifiedName === qualifiedName
  ));
}

function findScopedNode(
  ctx: ExtractorContext,
  kinds: ReadonlySet<string>,
  name: string
): Node | undefined {
  const qualifiedName = currentQualifiedName(ctx, name);
  return ctx.nodes.find((node) => (
    kinds.has(node.kind) &&
    node.qualifiedName === qualifiedName
  ));
}

function parseNamedPortConnection(text: string): { formal: string; actual: string } | null {
  const match = text.trim().replace(/,\s*$/, '').match(/^\.\s*([A-Za-z_][A-Za-z0-9_$]*)\s*\(([\s\S]*)\)$/);
  if (!match) return null;
  return {
    formal: match[1]!,
    actual: match[2]!.replace(/\s+/g, ' ').trim(),
  };
}

function simpleActualSignalName(actual: string): string | undefined {
  const stripped = actual.trim().replace(/^[!~]\s*/, '');
  const match = stripped.match(/^([A-Za-z_][A-Za-z0-9_$]*)(?:\s*(?:\[[^\]]+\]|\.[A-Za-z_][A-Za-z0-9_$]*))*$/);
  return match?.[1];
}

function createNamedDecls(
  ctx: ExtractorContext,
  nodes: SyntaxNode[],
  kind: 'field' | 'variable' | 'constant' | 'parameter' | 'type_alias',
  signaturePrefix?: string
): void {
  for (const node of nodes) {
    const idNode = firstIdentifier(node);
    if (!idNode) continue;
    const name = cleanIdentifier(getNodeText(idNode, ctx.source));
    if (
      (kind === 'field' || kind === 'variable') &&
      hasScopedNode(ctx, new Set(['field', 'variable']), name)
    ) {
      continue;
    }
    const signature = signaturePrefix
      ? (signaturePrefix.includes(name) ? signaturePrefix : `${signaturePrefix} ${name}`)
      : undefined;
    ctx.createNode(kind, name, node, { signature });
  }
}

function createSignalDecls(ctx: ExtractorContext, nodes: SyntaxNode[], declarationNode: SyntaxNode): void {
  const signature = compactSignature(declarationNode, ctx.source);
  for (const node of nodes) {
    const idNode = firstIdentifier(node);
    if (!idNode) continue;
    const name = cleanIdentifier(getNodeText(idNode, ctx.source));
    if (hasScopedNode(ctx, new Set(['field', 'variable']), name)) continue;
    ctx.createNode('variable', name, node, { signature });
  }
}

function handlePackageImport(node: SyntaxNode, ctx: ExtractorContext): boolean {
  const imports = descendantsOfType(node, new Set(['package_import_item']));
  const parentId = ctx.nodeStack[ctx.nodeStack.length - 1];
  const signature = getNodeText(node, ctx.source).trim();

  for (const item of imports) {
    const pkg = firstDescendantOfType(item, new Set(['package_identifier']));
    if (!pkg) continue;
    const symbol = item.namedChildren
      .filter((child) => IDENTIFIER_TYPES.has(child.type))
      .at(-1);
    const pkgName = cleanIdentifier(getNodeText(firstIdentifier(pkg) ?? pkg, ctx.source));
    const symbolName = symbol ? cleanIdentifier(getNodeText(symbol, ctx.source)) : '*';
    const importName = symbolName === '*' ? `${pkgName}::*` : `${pkgName}::${symbolName}`;

    ctx.createNode('import', importName, item, { signature });
    if (parentId) {
      ctx.addUnresolvedReference({
        fromNodeId: parentId,
        referenceName: importName,
        referenceKind: 'imports',
        line: item.startPosition.row + 1,
        column: item.startPosition.column,
      });
    }
  }

  return true;
}

function handleParameterDeclaration(node: SyntaxNode, ctx: ExtractorContext): boolean {
  const assignments = descendantsOfType(node, new Set(['param_assignment']));
  createNamedDecls(ctx, assignments, 'parameter', 'parameter');

  const typeAssignments = descendantsOfType(node, new Set(['type_assignment']));
  createNamedDecls(ctx, typeAssignments, 'type_alias', 'type');
  return true;
}

function handleDataDeclaration(node: SyntaxNode, ctx: ExtractorContext): boolean {
  const packageImport = namedChildOfType(node, new Set(['package_import_declaration']));
  if (packageImport) {
    ctx.visitNode(packageImport);
    return true;
  }

  const typeDecl = namedChildOfType(node, new Set(['type_declaration', 'net_type_declaration']));
  if (typeDecl) {
    ctx.visitNode(typeDecl);
    return true;
  }

  const decls = descendantsOfType(node, new Set(['variable_decl_assignment']));
  const parentKind = currentParentKind(ctx);
  const kind = parentKind === 'class' || parentKind === 'struct'
    ? 'field'
    : 'variable';
  createNamedDecls(ctx, decls, kind, compactSignature(node, ctx.source));
  return true;
}

function handleNetDeclaration(node: SyntaxNode, ctx: ExtractorContext): boolean {
  const decls = descendantsOfType(node, new Set(['net_decl_assignment']));
  createNamedDecls(ctx, decls, 'variable', compactSignature(node, ctx.source) ?? 'net');
  return true;
}

function handlePortDeclaration(node: SyntaxNode, ctx: ExtractorContext): boolean {
  const parentKind = currentParentKind(ctx);
  if (parentKind !== 'module' && parentKind !== 'interface') return false;

  const ports = descendantsOfType(node, new Set(['port_identifier']));
  createSignalDecls(ctx, ports, node);
  return true;
}

function handleClassProperty(node: SyntaxNode, ctx: ExtractorContext): boolean {
  const decls = descendantsOfType(node, new Set(['variable_decl_assignment']));
  createNamedDecls(ctx, decls, 'field', compactSignature(node, ctx.source));
  return true;
}

function handleTypeDeclaration(node: SyntaxNode, ctx: ExtractorContext): boolean {
  const nameNode = trailingIdentifier(node);
  if (!nameNode) return true;
  const name = cleanIdentifier(getNodeText(nameNode, ctx.source));
  const text = getNodeText(node, ctx.source);

  if (/\benum\b/.test(text)) {
    const enumNode = ctx.createNode('enum', name, node, { signature: compactSignature(node, ctx.source) });
    if (enumNode) {
      ctx.pushScope(enumNode.id);
      const members = descendantsOfType(node, new Set(['enum_name_declaration']));
      for (const member of members) {
        const memberId = firstIdentifier(member);
        if (!memberId) continue;
        ctx.createNode('enum_member', cleanIdentifier(getNodeText(memberId, ctx.source)), member);
      }
      ctx.popScope();
    }
    return true;
  }

  if (/\bstruct\b|\bunion\b/.test(text)) {
    const structNode = ctx.createNode('struct', name, node, { signature: compactSignature(node, ctx.source) });
    if (structNode) {
      ctx.pushScope(structNode.id);
      const members = descendantsOfType(node, new Set(['struct_union_member']));
      for (const member of members) {
        const fields = descendantsOfType(member, new Set(['variable_decl_assignment']));
        createNamedDecls(ctx, fields, 'field', compactSignature(member, ctx.source));
      }
      ctx.popScope();
    }
    return true;
  }

  ctx.createNode('type_alias', name, node, { signature: compactSignature(node, ctx.source) });
  return true;
}

function handleSubroutineDeclaration(node: SyntaxNode, ctx: ExtractorContext): boolean {
  const name = resolveVerilogName(node, ctx.source);
  if (!name) return true;

  const parentKind = currentParentKind(ctx);
  const kind = parentKind === 'class' || parentKind === 'interface' || parentKind === 'struct'
    ? 'method'
    : 'function';
  const created = ctx.createNode(kind, name, node, {
    signature: compactSignature(node, ctx.source),
    isStatic: node.text.includes('static'),
  });
  if (!created) return true;

  const body = node.type === 'function_declaration'
    ? firstDescendantOfType(node, new Set(['function_body_declaration']))
    : node.type === 'task_declaration'
      ? firstDescendantOfType(node, new Set(['task_body_declaration']))
      : node;

  ctx.pushScope(created.id);
  const walkRoot = body ?? node;
  for (let i = 0; i < walkRoot.namedChildCount; i++) {
    const child = walkRoot.namedChild(i);
    if (child) ctx.visitNode(child);
  }
  ctx.popScope();
  return true;
}

function handleInstantiation(node: SyntaxNode, ctx: ExtractorContext): boolean {
  const targetNode = firstIdentifier(node);
  if (!targetNode) return true;
  const targetName = cleanIdentifier(getNodeText(targetNode, ctx.source));
  const parentId = ctx.nodeStack[ctx.nodeStack.length - 1];

  if (parentId) {
    for (const referenceKind of ['instantiates', 'connects'] as const) {
      ctx.addUnresolvedReference({
        fromNodeId: parentId,
        referenceName: targetName,
        referenceKind,
        line: targetNode.startPosition.row + 1,
        column: targetNode.startPosition.column,
      });
    }
  }

  const instances = activeDescendantsOfType(node, new Set(['hierarchical_instance']), ctx);
  for (const inst of instances) {
    const nameOfInstance = firstDescendantOfType(inst, new Set(['name_of_instance']));
    const instName = firstIdentifier(nameOfInstance ?? inst);
    if (!instName) continue;
    const instanceName = cleanIdentifier(getNodeText(instName, ctx.source));

    const portConnectionNodes = activeDescendantsOfType(inst, new Set(['named_port_connection']), ctx);
    const parsedConnections = portConnectionNodes
      .map((conn) => ({
        node: conn,
        text: getNodeText(conn, ctx.source).replace(/\s+/g, ' ').trim(),
      }))
      .map((conn) => ({
        ...conn,
        parsed: parseNamedPortConnection(conn.text),
      }))
      .filter((conn): conn is {
        node: SyntaxNode;
        text: string;
        parsed: { formal: string; actual: string };
      } => Boolean(conn.parsed));
    const portConnections = parsedConnections.map((conn) => (
      conn.parsed.actual
        ? `.${conn.parsed.formal} (${conn.parsed.actual})`
        : `.${conn.parsed.formal} ()`
    ));
    const signature = portConnections.length > 0
      ? `instantiates ${targetName} (${portConnections.join(', ')})`
      : `instantiates ${targetName}`;

    const instanceNode = ctx.createNode('variable', instanceName, inst, {
      signature,
    });
    if (!instanceNode) continue;

    for (const conn of parsedConnections) {
      const actualName = simpleActualSignalName(conn.parsed.actual);
      if (!actualName) continue;

      const actualNode = findScopedNode(ctx, new Set(['field', 'variable']), actualName);
      if (!actualNode) continue;

      ctx.addEdge({
        source: instanceNode.id,
        target: actualNode.id,
        kind: 'port_connection',
        line: conn.node.startPosition.row + 1,
        column: conn.node.startPosition.column,
        provenance: 'tree-sitter',
        metadata: {
          targetModule: targetName,
          instance: instanceName,
          formalPort: conn.parsed.formal,
          actual: conn.parsed.actual,
        },
      });
    }
  }

  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);
    if (child) ctx.visitNode(child);
  }

  return true;
}

function handleMethodCall(node: SyntaxNode, ctx: ExtractorContext): boolean {
  const parentId = ctx.nodeStack[ctx.nodeStack.length - 1];
  if (!parentId) return true;

  const body = firstDescendantOfType(node, new Set(['method_call_body'])) ?? node;
  const methodId = firstDescendantOfType(body, new Set(['method_identifier']));
  const methodNameNode = firstIdentifier(methodId ?? body);
  if (!methodNameNode) return true;

  const methodName = cleanIdentifier(getNodeText(methodNameNode, ctx.source));
  ctx.addUnresolvedReference({
    fromNodeId: parentId,
    referenceName: methodName,
    referenceKind: 'calls',
    line: methodNameNode.startPosition.row + 1,
    column: methodNameNode.startPosition.column,
  });
  return true;
}

export const verilogExtractor: LanguageExtractor = {
  functionTypes: [],
  classTypes: [],
  methodTypes: [],
  interfaceTypes: [],
  structTypes: [],
  enumTypes: [],
  enumMemberTypes: ['enum_name_declaration'],
  typeAliasTypes: [],
  importTypes: [],
  callTypes: ['tf_call', 'system_tf_call'],
  variableTypes: [],
  fieldTypes: [],
  nameField: 'name',
  bodyField: 'body',
  paramsField: 'parameters',
  resolveName: resolveVerilogName,
  resolveBody: (node) => {
    if (node.type === 'function_declaration') {
      return firstDescendantOfType(node, new Set(['function_body_declaration']));
    }
    if (node.type === 'task_declaration') {
      return firstDescendantOfType(node, new Set(['task_body_declaration']));
    }
    if (node.type === 'class_constructor_declaration') {
      return node;
    }
    return null;
  },
  getSignature: compactSignature,
  isStatic: (node) => node.text.includes('static'),
  extractBareCall: (node, source) => {
    if (node.type !== 'method_call') return undefined;
    const body = firstDescendantOfType(node, new Set(['method_call_body'])) ?? node;
    const methodId = firstDescendantOfType(body, new Set(['method_identifier']));
    const methodNameNode = firstIdentifier(methodId ?? body);
    return methodNameNode ? cleanIdentifier(getNodeText(methodNameNode, source)) : undefined;
  },
  visitNode: (node, ctx) => {
    if (!isActiveNode(node, ctx) || isPreprocessorDirective(node, ctx)) {
      return true;
    }

    const name = resolveVerilogName(node, ctx.source);

    if (node.type === 'module_declaration' && name) {
      return createScopedNode(ctx, 'module', node, name);
    }
    if (node.type === 'interface_declaration' && name) {
      return createScopedNode(ctx, 'interface', node, name);
    }
    if (node.type === 'package_declaration' && name) {
      return createScopedNode(ctx, 'namespace', node, name);
    }
    if (node.type === 'program_declaration' && name) {
      return createScopedNode(ctx, 'module', node, name);
    }
    if (node.type === 'checker_declaration' && name) {
      return createScopedNode(ctx, 'module', node, name, { signature: 'checker' });
    }
    if (node.type === 'covergroup_declaration' && name) {
      return createScopedNode(ctx, 'class', node, name, { signature: 'covergroup' });
    }
    if (node.type === 'class_declaration' && name) {
      return createScopedNode(ctx, 'class', node, name);
    }
    if (node.type === 'interface_class_declaration' && name) {
      return createScopedNode(ctx, 'interface', node, name);
    }
    if (node.type === 'package_import_declaration') {
      return handlePackageImport(node, ctx);
    }
    if (node.type === 'ansi_port_declaration' || node.type === 'port_declaration') {
      return handlePortDeclaration(node, ctx);
    }
    if (
      node.type === 'function_declaration' ||
      node.type === 'task_declaration' ||
      node.type === 'class_constructor_declaration'
    ) {
      return handleSubroutineDeclaration(node, ctx);
    }
    if (node.type === 'parameter_declaration' || node.type === 'local_parameter_declaration') {
      return handleParameterDeclaration(node, ctx);
    }
    if (node.type === 'data_declaration') {
      return handleDataDeclaration(node, ctx);
    }
    if (node.type === 'net_declaration') {
      return handleNetDeclaration(node, ctx);
    }
    if (node.type === 'class_property') {
      return handleClassProperty(node, ctx);
    }
    if (node.type === 'type_declaration' || node.type === 'net_type_declaration') {
      return handleTypeDeclaration(node, ctx);
    }
    if (
      node.type === 'module_instantiation' ||
      node.type === 'interface_instantiation' ||
      node.type === 'program_instantiation' ||
      node.type === 'checker_instantiation'
    ) {
      return handleInstantiation(node, ctx);
    }
    if (node.type === 'method_call') {
      return handleMethodCall(node, ctx);
    }

    return false;
  },
};

export const systemverilogExtractor = verilogExtractor;
