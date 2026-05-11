import { ai, MODELS } from './gemini';
import { DocumentElement } from '../types';

export async function solveElement(element: DocumentElement): Promise<string> {
  const prompt = `You are a specialist engineering tutor. Solve the following question/problem extracted from a paper. 
  
  QUESTION TYPE: ${element.type}
  CONTENT: ${element.content}
  ${element.metadata?.label ? `LABEL: ${element.metadata.label}` : ''}
  
  Provide a step-by-step clear solution. Use LaTeX for math. Be accurate and concise. 
  If there is a diagram reference, assume the diagram provides the necessary context described in the content.`;

  try {
    const response = await ai.models.generateContent({
      model: MODELS.flash,
      contents: [{ parts: [{ text: prompt }] }]
    });
    return response.text;
  } catch (error) {
    console.error("Solver error:", error);
    return "Failed to generate solution. System reported: " + (error instanceof Error ? error.message : String(error));
  }
}
