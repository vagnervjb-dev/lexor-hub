// Fluxos padrão de etapas (abertura / alteração / encerramento) — cópia
// de FLUXOS em index.html, usada como fallback quando a coleção
// Firestore `fluxos` ainda não tem edição salva pra aquele tipo (mesma
// regra de carregarFluxosFirebase no front). Se mudar o padrão em
// index.html, atualizar aqui também.
export const FLUXOS_PADRAO = {
  abertura: {
    titulo: 'Abertura de empresa',
    meta: '25/06/2026',
    etapas: [
      { num:'01', nome:'Coleta de dados', sla:3, desc:'Reunir documentos pessoais dos sócios, dados da empresa e informações para viabilidade.', checklist:['RG e CPF de todos os sócios','Comprovante de residência dos sócios','Endereço comercial confirmado','Atividade principal (CNAE) definida','Capital social definido'] },
      { num:'02', nome:'Viabilidade', sla:2, desc:'Verificar viabilidade do endereço comercial e da atividade junto à prefeitura.', checklist:['Protocolo', 'Viabilidade em análise', 'Viabilidade deferida'] },
      { num:'03', nome:'Contrato social', sla:3, desc:'Elaborar minuta do contrato social conforme dados coletados e aprovados.', checklist:['Elaboração', 'Aguardando validação do cliente', 'Minuta validada pelo cliente'] },
      { num:'04', nome:'DBE', sla:1, desc:'Preencher Documento Básico de Entrada na Receita Federal.', checklist:['Transmissão', 'Liberação'] },
      { num:'05', nome:'Junta Comercial', sla:5, desc:'Protocolar na Junta Comercial e acompanhar aprovação do registro.', checklist:['Preenchimento formulários', 'Taxa para pagamento', 'Assinatura', 'Protocolo', 'Registro', 'Liberação do CNPJ', 'Verificar regime de tributação'] },
      { num:'06', nome:'Insc. Municipal / Alvará', sla:3, desc:'Solicitar inscrição municipal e alvará de funcionamento na prefeitura.', checklist:['Protocolo', 'Liberação IM', 'Emissão TFE'] },
      { num:'07', nome:'Nota fiscal', sla:2, desc:'Liberar emissão de nota fiscal junto à prefeitura.', checklist:['Habilitação de NF solicitada','NF liberada para emissão'] },
      { num:'08', nome:'Concluído', sla:0, desc:'Processo finalizado. CNPJ ativo e documentos entregues ao cliente.', checklist:['Documentos entregues ao cliente','Processo arquivado no sistema'] },
    ]
  },
  alteracao: {
    titulo: 'Alteração contratual',
    meta: '25/06/2026',
    etapas: [
      { num:'01', nome:'Viabilidade', sla:2, desc:'Verificar viabilidade da alteração pretendida (endereço, atividade, sócios).', checklist:['Protocolo', 'Viabilidade em análise', 'Viabilidade deferida'] },
      { num:'02', nome:'Minuta contrato de alteração', sla:3, desc:'Elaborar minuta do contrato de alteração conforme as mudanças solicitadas.', checklist:['Elaboração', 'Aguardando validação do cliente', 'Minuta validada pelo cliente'] },
      { num:'03', nome:'Validação minuta', sla:2, desc:'Cliente valida e aprova a minuta do contrato de alteração.', checklist:['Minuta aprovada pelo cliente','Assinatura de todos os sócios coletada'] },
      { num:'04', nome:'Receita Federal | DBE', sla:1, desc:'Preencher e protocolar o DBE na Receita Federal com as alterações.', checklist:['Transmissão', 'Liberação'] },
      { num:'05', nome:'Junta Comercial | Registro', sla:5, desc:'Protocolar a alteração na Junta Comercial e aguardar registro.', checklist:['Preenchimento formulários', 'Taxa para pagamento', 'Assinatura', 'Protocolo', 'Registro'] },
      { num:'06', nome:'Documentos para cliente', sla:1, desc:'Organizar e enviar os documentos atualizados ao cliente.', checklist:['Contrato alterado emitido','Cartão CNPJ atualizado','Documentos enviados ao cliente'] },
      { num:'07', nome:'Prefeitura | I.M.', sla:3, desc:'Atualizar inscrição municipal e alvará conforme alteração realizada.', checklist:['Protocolo', 'Liberação IM'] },
      { num:'08', nome:'Credenciamento', sla:3, desc:'Credenciamento em órgãos específicos se a alteração exigir.', checklist:['Órgãos identificados','Credenciamento solicitado','Credenciamento aprovado'] },
      { num:'09', nome:'Órgão de classe | CRM', sla:5, desc:'Atualizar registro em órgão de classe (CRM, CRC, OAB, CREA etc.) se aplicável.', checklist:['Órgão de classe identificado','Atualização solicitada','Registro atualizado'] },
      { num:'10', nome:'Conferência de alteração', sla:1, desc:'Conferir todos os documentos e sistemas atualizados antes de encerrar.', checklist:['Contrato registrado conferido','CNPJ atualizado na Receita','IM atualizada','Órgãos de classe atualizados','Processo arquivado'] },
    ]
  },
  encerramento: {
    titulo: 'Encerramento de empresa',
    meta: '01/07/2026',
    etapas: [
      { num:'01', nome:'Informar DP e contábil', sla:1, desc:'Comunicar oficialmente os departamentos de DP e contabilidade sobre o encerramento.', checklist:['DP informado','Contabilidade informada','Obrigações trabalhistas verificadas'] },
      { num:'02', nome:'Levantamento de débitos', sla:3, desc:'Levantar todos os débitos fiscais, trabalhistas e previdenciários da empresa.', checklist:['Débitos federais levantados','Débitos estaduais levantados','Débitos municipais levantados','Débitos trabalhistas levantados'] },
      { num:'03', nome:'Verificação envio de débitos', sla:2, desc:'Verificar o envio e regularização de todas as declarações pendentes.', checklist:['Declarações fiscais enviadas','Declarações previdenciárias enviadas','Pendências identificadas e tratadas'] },
      { num:'04', nome:'Recálculo de débitos', sla:3, desc:'Recalcular débitos com juros e multa atualizada para pagamento ou parcelamento.', checklist:['Cálculo atualizado','Guias de pagamento emitidas','Pagamento ou parcelamento confirmado'] },
      { num:'05', nome:'Receita Federal | DBE', sla:1, desc:'Preencher e protocolar DBE de encerramento na Receita Federal.', checklist:['Transmissão', 'Liberação'] },
      { num:'06', nome:'Junta Comercial | Registro', sla:5, desc:'Protocolar a distrato na Junta Comercial e aguardar aprovação.', checklist:['Preenchimento formulários', 'Taxa para pagamento', 'Assinatura', 'Protocolo', 'Registro', 'Liberação do CNPJ', 'Verificar regime de tributação'] },
      { num:'07', nome:'Documentos para cliente', sla:1, desc:'Organizar e entregar os documentos de encerramento ao cliente.', checklist:['Distrato emitido','Certidões de baixa emitidas','Documentos entregues ao cliente'] },
      { num:'08', nome:'Prefeitura | I.M.', sla:3, desc:'Dar baixa na inscrição municipal e cancelar o alvará de funcionamento.', checklist:['Protocolo', 'Liberação IM', 'Emissão TFE'] },
      { num:'09', nome:'Órgão de classe', sla:5, desc:'Cancelar registro em órgão de classe se aplicável (CRM, OAB, CRC, CREA etc.).', checklist:['Órgão de classe notificado','Cancelamento de registro confirmado'] },
      { num:'10', nome:'Conferência de encerramento', sla:1, desc:'Conferência final de todos os documentos e sistemas para encerrar o processo.', checklist:['CNPJ baixado na Receita','Junta Comercial registrada','IM cancelada','Órgãos de classe cancelados','Processo arquivado no sistema'] },
    ]
  }
};
