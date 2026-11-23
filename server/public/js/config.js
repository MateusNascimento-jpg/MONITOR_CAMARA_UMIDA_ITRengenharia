// Configurações: editor dos limites com prévia ao vivo.
import { $, $$, h, icone } from './dom.js';
import { Proveta } from './regua.js';
import { FAIXAS, NOME, LIMITES_PADRAO, MEDIDA, bandas, dominio, validar, n } from './regras.js';

export function criarConfig({ api, aoSalvar }) {
  const form = $('#form-limites'), msg = $('#config-msg'), salvar = $('#config-salvar'), token = $('#token');
  const prov = { temp: new Proveta($('#previa-temp'), 'temp'), umid: new Proveta($('#previa-umid'), 'umid') };
  let salvos = null, leitura = null, editando = false;

  const campo = (nome, rotulo, passo = '0.1') => h('input', {
    type: 'number', step: passo, name: nome, 'aria-label': rotulo, required: '', inputmode: 'decimal', autocomplete: 'off',
  });
  const erroEl = (id) => h('p', { class: 'campo-erro', id: `erro-${id.replace('.', '-')}`, 'data-erro': id });
  const tag = (k) => h('span', { class: `nivel e-${k}` }, icone(k), NOME[k]);

  for (const k of FAIXAS) {
    $('#campos-temp').append(h('div', { class: 'linha-campo' }, tag(k),
      h('label', {}, h('span', {}, 'Mínimo'), campo(`temp.${k}.min`, `Temperatura ${NOME[k]}, mínimo em °C`)),
      h('label', {}, h('span', {}, 'Máximo'), campo(`temp.${k}.max`, `Temperatura ${NOME[k]}, máximo em °C`)), erroEl(`temp.${k}`)));
    $('#campos-umid').append(h('div', { class: 'linha-campo' }, tag(k),
      h('label', {}, h('span', {}, 'A partir de'), campo(`umid.${k}`, `Umidade ${NOME[k]}, a partir de, em %`)), erroEl(`umid.${k}`)));
  }

  const el = (nome) => form.elements[nome];
  const num = (nome) => (el(nome).value === '' ? NaN : Number(el(nome).value));

  function ler() {
    const l = { temp: {}, umid: {}, histerese: { temp: num('histerese.temp'), umid: num('histerese.umid') }, sem_dados_min: num('sem_dados_min') };
    for (const k of FAIXAS) {
      l.temp[k] = { min: num(`temp.${k}.min`), max: num(`temp.${k}.max`) };
      l.umid[k] = num(`umid.${k}`);
    }
    return l;
  }

  function escrever(l) {
    for (const k of FAIXAS) {
      el(`temp.${k}.min`).value = l.temp[k].min;
      el(`temp.${k}.max`).value = l.temp[k].max;
      el(`umid.${k}`).value = l.umid[k];
    }
    el('histerese.temp').value = l.histerese.temp;
    el('histerese.umid').value = l.histerese.umid;
    el('sem_dados_min').value = l.sem_dados_min;
    conferir();
  }

  const recado = (texto, tipo = '') => { msg.textContent = texto; msg.dataset.tipo = tipo; };

  function conferir() {
    const l = ler(), erros = validar(l);
    $$('[data-erro]', form).forEach((p) => {
      const id = p.dataset.erro, ruim = !!erros[id];
      p.textContent = erros[id] || '';
      $$('input', form).filter((i) => i.name === id || i.name.startsWith(`${id}.`)).forEach((i) => {
        i.setAttribute('aria-invalid', String(ruim));
        if (ruim) i.setAttribute('aria-describedby', p.id); else i.removeAttribute('aria-describedby');
      });
    });
    const valido = !Object.keys(erros).length;
    $('#previa').classList.toggle('invalida', !valido);
    if (valido) previa(l);
    const mudou = salvos && JSON.stringify(l) !== JSON.stringify(salvos);
    editando = !!mudou;
    salvar.disabled = !mudou || !valido;
    return { l, valido };
  }

  function previa(l) {
    for (const k of ['temp', 'umid']) {
      prov[k].mostrar(l, leitura ? leitura[k] : null);
      const u = MEDIDA[k].unidade, [lo, hi] = dominio(k, l);
      $(`#previa-${k}-lista`).replaceChildren(...bandas(k, l).slice().reverse().map((b) => h('li', { class: `e-${b.estado}` }, icone(b.estado), h('span', {}, NOME[b.estado]),
        h('strong', {}, b.de === lo ? `abaixo de ${n(b.ate)} ${u}` : b.ate === hi ? `a partir de ${n(b.de)} ${u}` : `${n(b.de)} a ${n(b.ate)} ${u}`))));
    }
  }

  form.addEventListener('input', (e) => {
    if (e.target === token) { $('#erro-token').textContent = ''; token.removeAttribute('aria-invalid'); return; }
    conferir();
    recado(editando ? 'Há alterações não salvas.' : '');
  });

  $('#config-padrao').addEventListener('click', () => {
    escrever(LIMITES_PADRAO);
    recado(editando ? 'Valores padrão preenchidos. Salve para aplicar.' : 'A câmara já usa os valores padrão.');
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const { l, valido } = conferir();
    if (!valido || salvar.classList.contains('ocupado')) return;
    if (!token.value) {
      $('#erro-token').textContent = 'Digite o token de administrador para salvar.';
      token.setAttribute('aria-invalid', 'true');
      token.focus();
      return;
    }
    salvar.classList.add('ocupado');
    recado('Salvando…');
    try {
      salvos = await api.salvar(l, token.value);
      token.value = '';
      // Edição feita durante o salvamento não se perde: continua no formulário, por salvar
      if (JSON.stringify(ler()) === JSON.stringify(l)) escrever(salvos); else conferir();
      recado(`Limites salvos. A placa recebe os novos valores no próximo envio.${editando ? ' Há alterações novas não salvas.' : ''}`, 'ok');
      aoSalvar();
    } catch (err) {
      if (err.status === 401) {
        $('#erro-token').textContent = 'Token inválido. Confira com quem administra o painel.';
        token.setAttribute('aria-invalid', 'true');
        token.select();
        recado('Nada foi salvo.', 'erro');
      } else recado(err.status === 400 ? `O servidor recusou: ${err.message}.` : 'Sem conexão com o servidor. Nada foi salvo; tente de novo.', 'erro');
    }
    salvar.classList.remove('ocupado');
  });

  return {
    receber(atual) {
      leitura = atual.leitura;
      const novo = JSON.stringify(atual.limites) !== JSON.stringify(salvos);
      if (novo && !editando && !salvar.classList.contains('ocupado')) { salvos = atual.limites; escrever(salvos); }
    },
  };
}
