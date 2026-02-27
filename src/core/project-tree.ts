// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface TreeNode {
  name: string;
  children: Map<string, TreeNode>;
  isFile: boolean;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Build a compact ASCII tree from a list of relative file paths (from scanned tasks).
 *
 * - Uses `├──` / `└──` / `│` for hierarchy
 * - Directories sorted before files, both alphabetically
 * - Deep paths (> maxDepth levels) condensed as `a/b/c/d` on a single line
 * - Aims for < 300 tokens (cl100k_base) on 500+ file projects
 */
export function buildProjectTree(filePaths: string[], maxDepth = 4): string {
  if (filePaths.length === 0) return '';

  const root = buildTreeStructure(filePaths);

  // Condense deep branches before rendering
  condenseDeep(root, maxDepth, 0);

  const lines: string[] = [];
  renderNode(root, '', true, lines);

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Internal: tree construction
// ---------------------------------------------------------------------------

function buildTreeStructure(filePaths: string[]): TreeNode {
  const root: TreeNode = { name: '', children: new Map(), isFile: false };

  for (const filePath of filePaths) {
    const parts = filePath.split('/');
    let current = root;

    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      const isLast = i === parts.length - 1;

      if (!current.children.has(part)) {
        current.children.set(part, {
          name: part,
          children: new Map(),
          isFile: isLast,
        });
      } else if (isLast) {
        current.children.get(part)!.isFile = true;
      }

      current = current.children.get(part)!;
    }
  }

  return root;
}

// ---------------------------------------------------------------------------
// Internal: condense deep branches
// ---------------------------------------------------------------------------

/**
 * Condense branches deeper than maxDepth by collapsing single-child directory
 * chains into "a/b/c" path segments.
 */
function condenseDeep(node: TreeNode, maxDepth: number, currentDepth: number): void {
  const entries = [...node.children.entries()];

  for (const [key, child] of entries) {
    if (!child.isFile && child.children.size > 0 && currentDepth >= maxDepth - 1) {
      // At maxDepth boundary — collapse single-child chains
      collapseChain(node, key, child);
    } else {
      condenseDeep(child, maxDepth, currentDepth + 1);
    }
  }
}

function collapseChain(parent: TreeNode, key: string, node: TreeNode): void {
  // Collapse single-child directory chains: a/ -> b/ -> c/ => "a/b/c"
  let current = node;
  const pathParts = [current.name];

  while (!current.isFile && current.children.size === 1) {
    const onlyChild = [...current.children.values()][0];
    if (onlyChild.isFile) break;
    pathParts.push(onlyChild.name);
    current = onlyChild;
  }

  if (pathParts.length > 1) {
    const collapsedName = pathParts.join('/');
    const collapsed: TreeNode = {
      name: collapsedName,
      children: current.children,
      isFile: current.isFile,
    };
    parent.children.delete(key);
    parent.children.set(collapsedName, collapsed);

    // Continue condensing children
    for (const child of collapsed.children.values()) {
      if (!child.isFile) {
        condenseDeep(child, 1, 0); // Already deep, continue collapsing
      }
    }
  } else {
    // Not collapsible, but still condense children at depth
    for (const child of node.children.values()) {
      if (!child.isFile && child.children.size > 0) {
        collapseChain(node, child.name, child);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Internal: rendering
// ---------------------------------------------------------------------------

function renderNode(node: TreeNode, prefix: string, isRoot: boolean, lines: string[]): void {
  if (isRoot) {
    // Render root's children directly
    renderChildren(node, prefix, lines);
    return;
  }

  lines.push(`${node.name}${node.isFile ? '' : '/'}`);
  renderChildren(node, prefix, lines);
}

function renderChildren(node: TreeNode, prefix: string, lines: string[]): void {
  const sorted = sortChildren(node.children);
  const count = sorted.length;

  for (let i = 0; i < count; i++) {
    const child = sorted[i];
    const isLast = i === count - 1;
    const connector = isLast ? '└── ' : '├── ';
    const childPrefix = prefix + (isLast ? '    ' : '│   ');

    const label = child.isFile && child.children.size === 0
      ? child.name
      : `${child.name}/`;

    lines.push(`${prefix}${connector}${label}`);

    if (child.children.size > 0) {
      renderChildren(child, childPrefix, lines);
    }
  }
}

/**
 * Sort: directories first (alphabetically), then files (alphabetically).
 */
function sortChildren(children: Map<string, TreeNode>): TreeNode[] {
  const dirs: TreeNode[] = [];
  const files: TreeNode[] = [];

  for (const child of children.values()) {
    if (child.children.size > 0 || !child.isFile) {
      dirs.push(child);
    } else {
      files.push(child);
    }
  }

  dirs.sort((a, b) => a.name.localeCompare(b.name));
  files.sort((a, b) => a.name.localeCompare(b.name));

  return [...dirs, ...files];
}
