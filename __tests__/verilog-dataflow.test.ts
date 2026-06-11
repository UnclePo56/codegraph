import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import CodeGraph from '../src';
import { initGrammars, loadGrammarsForLanguages } from '../src/extraction/grammars';
import { ToolHandler } from '../src/mcp/tools';

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
module child #(
  parameter int WIDTH = 8
) (
  input  logic       clk,
  input  logic       rst_n,
  input  logic [WIDTH-1:0] din,
  output logic [WIDTH-1:0] dout
);
logic valid;
assign dout = valid ? din : 8'h00;
endmodule
`);

    fs.writeFileSync(path.join(tempDir, 'top.sv'), `
module top (
  input  logic       clk,
  input  logic       rst_n,
  input  logic [7:0] data_in,
  output logic [7:0] data_out
);
logic [7:0] mid_data;

child #(.WIDTH(8)) u_child (
  .clk  (clk),
  .rst_n(rst_n),
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
    expect(top?.metadata?.hdl).toMatchObject({
      role: 'module',
      clocks: [expect.objectContaining({ name: 'clk', direction: 'input' })],
    });
    expect(child?.metadata?.hdl).toMatchObject({
      role: 'module',
      resets: [expect.objectContaining({
        name: 'rst_n',
        direction: 'input',
        polarity: 'active_low',
      })],
    });

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
    expect(instance?.metadata?.hdl).toMatchObject({
      role: 'instance',
      targetModule: 'child',
      parameterOverrides: [
        expect.objectContaining({ formal: 'WIDTH', actual: '8' }),
      ],
      portConnections: expect.arrayContaining([
        expect.objectContaining({ formal: 'din', actual: 'data_in' }),
        expect.objectContaining({ formal: 'dout', actual: 'mid_data' }),
      ]),
    });

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

    const dataOut = cg.getNodesInFile('top.sv').find((node) => (
      node.kind === 'variable' &&
      node.name === 'data_out'
    ));
    const midData = cg.getNodesInFile('top.sv').find((node) => (
      node.kind === 'variable' &&
      node.name === 'mid_data'
    ));
    const dependencies = cg.getIncomingEdges(dataOut!.id).filter((edge) => edge.kind === 'signal_dependency');
    expect(dependencies.some((edge) => (
      edge.source === midData?.id &&
      edge.metadata?.assignmentKind === 'continuous'
    ))).toBe(true);
  });

  it('labels HDL module relationships as instantiate-at sites', async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-hdl-trail-'));

    fs.writeFileSync(path.join(tempDir, 'child.sv'), `
module child (
  input  logic [7:0] din,
  output logic [7:0] dout
);
assign dout = din;
endmodule
`);

    fs.writeFileSync(path.join(tempDir, 'top.sv'), `
module top (
  input  logic [7:0] data_in,
  output logic [7:0] data_out
);
child u_child (
  .din  (data_in),
  .dout (data_out)
);
child u_child_b (
  .din  (data_in),
  .dout (data_out)
);
endmodule
`);

    cg = await CodeGraph.init(tempDir, { index: true });
    const handler = new ToolHandler(cg);

    try {
      const topNode = await handler.execute('codegraph_node', {
        symbol: 'top',
        projectPath: tempDir,
      });
      const topText = topNode.content[0]?.type === 'text' ? topNode.content[0].text : '';
      expect(topText).toContain('### HDL Trail');
      expect(topText).toContain('**Instantiates →** child');
      expect(topText).toContain('instantiate at top.sv:6 via u_child');
      expect(topText).toContain('instantiate at top.sv:10 via u_child_b');
      expect(topText).not.toContain('**Calls →**');

      const childNode = await handler.execute('codegraph_node', {
        symbol: 'child',
        projectPath: tempDir,
      });
      const childText = childNode.content[0]?.type === 'text' ? childNode.content[0].text : '';
      expect(childText).toContain('**Instantiated at ←** top');
      expect(childText).toContain('instantiate at top.sv:6 via u_child');
      expect(childText).toContain('instantiate at top.sv:10 via u_child_b');
      expect(childText).not.toContain('**Called by ←**');

      const callees = await handler.execute('codegraph_callees', {
        symbol: 'top',
        projectPath: tempDir,
      });
      const calleesText = callees.content[0]?.type === 'text' ? callees.content[0].text : '';
      expect(calleesText).toContain('## Instantiates from top');
      expect(calleesText).toContain('## Instantiates from top (2 found)');
      expect(calleesText.match(/- child \(module\) - child\.sv:2/g)?.length).toBe(2);
      expect(calleesText).toContain('instantiate at top.sv:6 via u_child');
      expect(calleesText).toContain('instantiate at top.sv:10 via u_child_b');

      const callers = await handler.execute('codegraph_callers', {
        symbol: 'child',
        projectPath: tempDir,
      });
      const callersText = callers.content[0]?.type === 'text' ? callers.content[0].text : '';
      expect(callersText).toContain('## Instantiated at child');
      expect(callersText).toContain('## Instantiated at child (2 found)');
      expect(callersText.match(/- top \(module\) - top\.sv:2/g)?.length).toBe(2);
      expect(callersText).toContain('instantiate at top.sv:6 via u_child');
      expect(callersText).toContain('instantiate at top.sv:10 via u_child_b');
    } finally {
      handler.closeAll();
    }
  });

  it('reports global HDL signal flow through modules, derivations, and output ports', async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-hdl-flow-'));

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
    const handler = new ToolHandler(cg);

    try {
      const response = await handler.execute('codegraph_node', {
        symbol: 'top::data_out',
        projectPath: tempDir,
      });
      const text = response.content[0]?.type === 'text' ? response.content[0].text : '';

      expect(text).toContain('### HDL Signal Flow');
      expect(text).toContain('**Qualified node:** `top::data_out`');
      expect(text).toContain('**Origin stimuli:**');
      expect(text).toContain('`child::dout` <=');
      expect(text).toContain('`child::valid`');
      expect(text).toContain('`child::din`');
      expect(text).toContain('valid ? din : 8\'h00');
      expect(text).toContain('top::data_in');
      expect(text).toContain('child::din');
      expect(text).toContain('child::dout');
      expect(text).toContain('**Traversed modules:** top');
      expect(text).toContain('child (child.sv:2)');
      expect(text).toContain('**Final output ports:** top::data_out');
    } finally {
      handler.closeAll();
    }
  });

  it('returns structured HDL signal flow for codegraph_hdl_signal_trace', async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-hdl-trace-'));

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
    const handler = new ToolHandler(cg);

    try {
      const response = await handler.execute('codegraph_hdl_signal_trace', {
        symbol: 'top::data_out',
        projectPath: tempDir,
      });
      const text = response.content[0]?.type === 'text' ? response.content[0].text : '';
      const parsed = JSON.parse(text) as Record<string, any>;

      expect(parsed.symbol?.qualifiedName).toBe('top::data_out');
      expect(parsed.originStimuli.map((node: Record<string, any>) => node.qualifiedName)).toContain('child::valid');
      expect(parsed.originStimuli.map((node: Record<string, any>) => node.qualifiedName)).toContain('top::data_in');
      expect(parsed.traversedModules.map((node: Record<string, any>) => node.name)).toEqual(expect.arrayContaining(['top', 'child']));
      expect(parsed.finalOutputPorts.map((node: Record<string, any>) => node.qualifiedName)).toContain('top::data_out');
      expect(parsed.derivations).toEqual(expect.arrayContaining([
        expect.objectContaining({
          target: expect.objectContaining({ qualifiedName: 'child::dout' }),
          expression: 'valid ? din : 8\'h00',
        }),
      ]));
      expect(parsed.upstream.nodes.map((node: Record<string, any>) => node.qualifiedName)).toEqual(expect.arrayContaining([
        'top::data_out',
        'top::mid_data',
        'child::dout',
        'child::din',
        'top::data_in',
      ]));
      expect(parsed.upstream.edges).toEqual(expect.arrayContaining([
        expect.objectContaining({
          kind: 'signal_dependency',
          source: expect.objectContaining({ qualifiedName: 'top::mid_data' }),
          target: expect.objectContaining({ qualifiedName: 'top::data_out' }),
        }),
        expect.objectContaining({
          kind: 'instance_output',
          source: expect.objectContaining({ qualifiedName: 'child::dout' }),
          target: expect.objectContaining({ qualifiedName: 'top::mid_data' }),
        }),
      ]));
    } finally {
      handler.closeAll();
    }
  });
});
