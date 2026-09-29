export async function fetchAllSalesOrders({ getOrders, params, pageSize }) {
  const loaded = [];
  let offset = 0;

  while (true) {
    const response = await getOrders({ ...params, limit: pageSize, offset });
    const page = Array.isArray(response) ? response : (response.orders || []);
    loaded.push(...page);
    const total = Array.isArray(response) ? loaded.length : Number(response.total ?? loaded.length);

    if (page.length === 0 || loaded.length >= total) return loaded;
    offset += page.length;
  }
}

export async function loadSalesOrdersForPerson({ activePerson, getOrders, pageSize }) {
  if (activePerson === '이준형') {
    const [leeOrders, kimOrders] = await Promise.all([
      fetchAllSalesOrders({ getOrders, params: { sales_person: '이준형' }, pageSize }),
      fetchAllSalesOrders({ getOrders, params: { sales_person: '김보수' }, pageSize }),
    ]);
    return [...leeOrders, ...kimOrders];
  }

  return fetchAllSalesOrders({ getOrders, params: { sales_person: activePerson }, pageSize });
}
