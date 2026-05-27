import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import CodeGraph from '../src';
import { initGrammars, loadGrammarsForLanguages } from '../src/extraction/grammars';

describe('Verilog/SystemVerilog module data-flow graph', () => {
  let tempDir: string | null = null;
  let cg: CodeGraph | null = null;

  beforeAll(async () => {
    await initGrammars();
    await loadGrammarsForLanguages(['verilog', 'systemverilog']);
  });

  afterEach(() => {
    cg?.close();
    cg = null;
    if (tempDir && fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
    tempDir = null;
  });

  it('resolves module-level connects edges and keeps ports/signals as variables', async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-hdl-'));

    fs.writeFileSync(path.join(tempDir, 'child.sv'), `
module child (
  input  logic       clk,
  input  logic [7:0] din,
  output logic [7:0] dout
);
logic valid;
assign dout = valid ? din : 8'h00;
endmodule
`);

    fs.writeFileSync(path.join(tempDir, 'top.sv'), `
module top (
  input  logic       clk,
  input  logic [7:0] data_in,
  output logic [7:0] data_out
);
logic [7:0] mid_data;

child u_child (
  .clk  (clk),
  .din  (data_in),
  .dout (mid_data)
);

assign data_out = mid_data;
endmodule
`);

    cg = await CodeGraph.init(tempDir, { index: true });

    const modules = cg.getNodesByKind('module');
    const top = modules.find((node) => node.name === 'top');
    const child = modules.find((node) => node.name === 'child');
    expect(top).toBeDefined();
    expect(child).toBeDefined();

    const connects = cg.getOutgoingEdges(top!.id).filter((edge) => edge.kind === 'connects');
    expect(connects.some((edge) => edge.target === child!.id)).toBe(true);

    const topVariables = cg.getNodesInFile('top.sv')
      .filter((node) => node.kind === 'variable')
      .map((node) => node.name);
    expect(topVariables).toEqual(expect.arrayContaining([
      'clk',
      'data_in',
      'data_out',
      'mid_data',
      'u_child',
    ]));

    const instance = cg.getNodesInFile('top.sv').find((node) => (
      node.kind === 'variable' &&
      node.name === 'u_child'
    ));
    expect(instance?.signature).toContain('.din (data_in)');
    expect(instance?.signature).toContain('.dout (mid_data)');

    const dataIn = cg.getNodesInFile('top.sv').find((node) => (
      node.kind === 'variable' &&
      node.name === 'data_in'
    ));
    const portConnections = cg.getOutgoingEdges(instance!.id).filter((edge) => edge.kind === 'port_connection');
    expect(portConnections.some((edge) => (
      edge.target === dataIn?.id &&
      edge.metadata?.formalPort === 'din' &&
      edge.metadata?.actual === 'data_in'
    ))).toBe(true);
  });
});
